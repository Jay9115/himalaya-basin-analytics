import contextlib
import inspect
import json
import math
import re
import statistics
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import numpy as np
import pandas as pd


ALLOWED_IMPORT_ROOTS = {"math", "statistics", "numpy", "pandas"}
SAFE_EXPORT_NAME = re.compile(r"[^A-Za-z0-9._-]+")
SUPPORTED_CHART_TYPES = {"line", "bar", "area", "scatter", "pie", "histogram"}


class LimitedBuffer:
    def __init__(self, limit: int) -> None:
        self.limit = max(0, int(limit))
        self.parts: List[str] = []
        self.size = 0
        self.truncated = False

    def write(self, value: Any) -> int:
        text = str(value)
        if self.size < self.limit:
            remaining = self.limit - self.size
            self.parts.append(text[:remaining])
        if len(text) > max(0, self.limit - self.size):
            self.truncated = True
        self.size += len(text)
        return len(text)

    def flush(self) -> None:
        return None

    def getvalue(self) -> str:
        output = "".join(self.parts)
        if self.truncated:
            output += "\n[output truncated]"
        return output


def _json_safe(value: Any, max_items: int = 2000) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.generic):
        return _json_safe(value.item(), max_items=max_items)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, pd.Series):
        return _json_safe(value.head(max_items).to_list(), max_items=max_items)
    if isinstance(value, pd.DataFrame):
        return _table_payload(value, name="result", max_rows=min(1000, max_items))
    if isinstance(value, dict):
        output: Dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= max_items:
                output["_truncated"] = True
                break
            output[str(key)] = _json_safe(item, max_items=max_items)
        return output
    if isinstance(value, (list, tuple, set)):
        output = []
        for index, item in enumerate(value):
            if index >= max_items:
                output.append({"_truncated": True})
                break
            output.append(_json_safe(item, max_items=max_items))
        return output
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    return str(value)


def _frame_from_any(data: Any) -> pd.DataFrame:
    if data is None:
        return pd.DataFrame()
    if isinstance(data, pd.DataFrame):
        return data.copy()
    if isinstance(data, pd.Series):
        return data.reset_index()
    return pd.DataFrame(data)


def _table_payload(data: Any, name: str, max_rows: int) -> Dict[str, Any]:
    frame = _frame_from_any(data)
    original_rows = int(len(frame))
    truncated = original_rows > max_rows
    if truncated:
        frame = frame.head(max_rows)
    safe = json.loads(frame.to_json(orient="split", date_format="iso"))
    return {
        "type": "table",
        "name": str(name),
        "columns": safe.get("columns", []),
        "rows": safe.get("data", []),
        "row_count": original_rows,
        "truncated": truncated,
    }


def _safe_import(name: str, globals_obj: Any = None, locals_obj: Any = None, fromlist: Iterable[str] = (), level: int = 0) -> Any:
    if level:
        raise ImportError("Relative imports are not allowed in custom operations")
    root = name.split(".", 1)[0]
    if root not in ALLOWED_IMPORT_ROOTS:
        raise ImportError(f"Import '{name}' is not allowed in custom operations")
    return __import__(name, globals_obj, locals_obj, tuple(fromlist), level)


def _apply_resource_limits(limits: Dict[str, Any]) -> None:
    try:
        import resource  # type: ignore
    except Exception:
        return

    memory_mb = int(limits.get("memory_mb") or 512)
    cpu_seconds = int(limits.get("cpu_seconds") or limits.get("timeout_seconds") or 15)
    try:
        memory_bytes = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except Exception:
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds + 1, cpu_seconds + 2))
    except Exception:
        pass


def _safe_export_filename(filename: str, default_suffix: str) -> str:
    cleaned = SAFE_EXPORT_NAME.sub("_", str(filename or "")).strip("._-")
    if not cleaned:
        cleaned = f"export{default_suffix}"
    if not Path(cleaned).suffix:
        cleaned = f"{cleaned}{default_suffix}"
    return Path(cleaned).name[:120]


class HBApi:
    def __init__(
        self,
        outputs: List[Dict[str, Any]],
        limits: Dict[str, Any],
        frame: pd.DataFrame,
        export_dir: Path,
        job_id: str,
    ) -> None:
        self._outputs = outputs
        self._limits = limits
        self._frame = frame
        self._export_dir = export_dir
        self._job_id = job_id

    def text(self, value: Any, name: str = "text") -> Dict[str, Any]:
        text_limit = int(self._limits.get("max_text_chars") or 12000)
        text = str(value)
        truncated = len(text) > text_limit
        payload = {
            "type": "text",
            "name": str(name),
            "value": text[:text_limit],
            "truncated": truncated,
        }
        self._add(payload)
        return payload

    def number(self, name: str, value: Any = None, units: Optional[str] = None) -> Dict[str, Any]:
        if value is None:
            value = name
            name = "number"
        numeric = _json_safe(value)
        payload = {
            "type": "number",
            "name": str(name),
            "value": numeric,
            "units": units,
        }
        self._add(payload)
        return payload

    def table(self, data: Any, name: str = "table", max_rows: Optional[int] = None) -> Dict[str, Any]:
        row_limit = int(max_rows or self._limits.get("max_table_rows") or 1000)
        row_limit = min(row_limit, int(self._limits.get("max_table_rows") or 1000))
        payload = _table_payload(data, name=str(name), max_rows=row_limit)
        self._add(payload)
        return payload

    def map_points(
        self,
        data: Any = None,
        *,
        name: str = "map_points",
        lat: str = "lat",
        lon: str = "lon",
        value: str = "value",
        style: Optional[Dict[str, Any]] = None,
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        frame = _frame_from_any(data if data is not None else self._frame)
        required = [lat, lon]
        missing = [column for column in required if column not in frame.columns]
        if missing:
            raise ValueError(f"map_points missing columns: {missing}")

        point_limit = int(max_points or self._limits.get("max_map_points") or 20000)
        point_limit = min(point_limit, int(self._limits.get("max_map_points") or 20000))
        truncated = len(frame) > point_limit
        if truncated:
            frame = frame.head(point_limit)

        columns = [lat, lon]
        if value in frame.columns:
            columns.append(value)
        if "date" in frame.columns and "date" not in columns:
            columns.append("date")
        if "variable" in frame.columns and "variable" not in columns:
            columns.append("variable")
        if "elev" in frame.columns and "elev" not in columns:
            columns.append("elev")

        selected = frame[columns].rename(columns={lat: "lat", lon: "lon", value: "value"})
        selected["lat"] = pd.to_numeric(selected["lat"], errors="coerce")
        selected["lon"] = pd.to_numeric(selected["lon"], errors="coerce")
        if "value" in selected.columns:
            selected["value"] = pd.to_numeric(selected["value"], errors="coerce")
        selected = selected.dropna(subset=["lat", "lon"])

        safe = json.loads(selected.to_json(orient="records", date_format="iso"))
        payload = {
            "type": "map_layer",
            "layer_type": "points",
            "name": str(name),
            "lat_column": "lat",
            "lon_column": "lon",
            "value_column": "value" if "value" in selected.columns else None,
            "features": safe,
            "style": _json_safe(style or {}),
            "count": int(len(selected)),
            "truncated": truncated,
        }
        self._add(payload)
        return payload

    def geojson(self, feature_collection: Dict[str, Any], name: str = "geojson", style: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {
            "type": "map_layer",
            "layer_type": "geojson",
            "name": str(name),
            "feature_collection": _json_safe(feature_collection),
            "style": _json_safe(style or {}),
        }
        self._add(payload)
        return payload

    def chart_line(
        self,
        data: Any,
        *,
        x: str = "date",
        y: str = "value",
        name: str = "line_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(data, chart_type="line", x=x, y=y, name=name, max_points=max_points)

    def chart_bar(
        self,
        data: Any,
        *,
        x: str,
        y: str,
        name: str = "bar_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(data, chart_type="bar", x=x, y=y, name=name, max_points=max_points)

    def chart_area(
        self,
        data: Any,
        *,
        x: str,
        y: str,
        name: str = "area_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(data, chart_type="area", x=x, y=y, name=name, max_points=max_points)

    def chart_scatter(
        self,
        data: Any,
        *,
        x: str,
        y: str,
        name: str = "scatter_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(data, chart_type="scatter", x=x, y=y, name=name, max_points=max_points)

    def chart_pie(
        self,
        data: Any,
        *,
        category: str,
        value: str,
        name: str = "pie_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(
            data,
            chart_type="pie",
            category=category,
            value=value,
            name=name,
            max_points=max_points,
        )

    def chart_histogram(
        self,
        data: Any,
        *,
        value: str = "value",
        bins: int = 12,
        name: str = "histogram_chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self.chart(
            data,
            chart_type="histogram",
            value=value,
            bins=bins,
            name=name,
            max_points=max_points,
        )

    def chart(
        self,
        data: Any,
        *,
        chart_type: str = "line",
        x: Optional[str] = None,
        y: Optional[str] = None,
        category: Optional[str] = None,
        value: Optional[str] = None,
        series: Optional[List[str]] = None,
        bins: int = 12,
        name: str = "chart",
        max_points: Optional[int] = None,
    ) -> Dict[str, Any]:
        normalized_type = str(chart_type or "line").strip().lower()
        if normalized_type not in SUPPORTED_CHART_TYPES:
            raise ValueError(
                f"Unsupported chart_type '{chart_type}'. Supported: {sorted(SUPPORTED_CHART_TYPES)}"
            )

        frame = _frame_from_any(data)
        series_list = [str(item) for item in (series or []) if str(item).strip()]
        limit = int(max_points or self._limits.get("max_chart_points") or 2000)
        limit = max(1, limit)

        if normalized_type == "histogram":
            return self._histogram_chart(frame, value=value or y or "value", bins=bins, name=name, max_points=limit)
        if normalized_type == "pie":
            return self._pie_chart(frame, category=category or x, value=value or y or "value", name=name, max_points=limit)
        return self._xy_chart(
            frame,
            chart_type=normalized_type,
            x=x or "date",
            y=y or (series_list[0] if series_list else "value"),
            series=series_list,
            name=name,
            max_points=limit,
        )

    def _xy_chart(
        self,
        frame: pd.DataFrame,
        *,
        chart_type: str,
        x: str,
        y: str,
        series: List[str],
        name: str,
        max_points: int,
    ) -> Dict[str, Any]:
        required = [x]
        if series:
            required.extend(series)
        else:
            required.append(y)
        missing = [column for column in required if column not in frame.columns]
        if missing:
            raise ValueError(f"{chart_type} chart missing columns: {missing}")

        selected_columns = list(dict.fromkeys(required))
        truncated = len(frame) > max_points
        if truncated:
            frame = frame.head(max_points)
        points = json.loads(frame[selected_columns].to_json(orient="records", date_format="iso"))
        payload = {
            "type": "chart",
            "chart_type": chart_type,
            "name": str(name),
            "x": x,
            "y": y,
            "series": series,
            "points": points,
            "truncated": truncated,
        }
        self._add(payload)
        return payload

    def _pie_chart(
        self,
        frame: pd.DataFrame,
        *,
        category: Optional[str],
        value: str,
        name: str,
        max_points: int,
    ) -> Dict[str, Any]:
        if not category:
            raise ValueError("pie chart requires a category column")
        required = [category, value]
        missing = [column for column in required if column not in frame.columns]
        if missing:
            raise ValueError(f"pie chart missing columns: {missing}")
        pie_frame = frame[required].copy()
        pie_frame = pie_frame.groupby(category, as_index=False)[value].sum()
        pie_frame = pie_frame.sort_values(by=value, ascending=False)
        truncated = len(pie_frame) > max_points
        if truncated:
            pie_frame = pie_frame.head(max_points)
        points = json.loads(pie_frame.to_json(orient="records", date_format="iso"))
        payload = {
            "type": "chart",
            "chart_type": "pie",
            "name": str(name),
            "category": category,
            "value": value,
            "points": points,
            "truncated": truncated,
        }
        self._add(payload)
        return payload

    def _histogram_chart(
        self,
        frame: pd.DataFrame,
        *,
        value: str,
        bins: int,
        name: str,
        max_points: int,
    ) -> Dict[str, Any]:
        if value not in frame.columns:
            raise ValueError(f"histogram chart missing column: {value}")
        numeric = pd.to_numeric(frame[value], errors="coerce").dropna()
        if numeric.empty:
            raise ValueError(f"histogram chart column '{value}' has no numeric values")
        bin_count = max(1, min(int(bins or 12), max_points, 200))
        counts, edges = np.histogram(numeric.to_numpy(), bins=bin_count)
        points = []
        for index, count in enumerate(counts.tolist()):
            start = float(edges[index])
            end = float(edges[index + 1])
            points.append(
                {
                    "bin_start": start,
                    "bin_end": end,
                    "bin_label": f"{start:.3f} to {end:.3f}",
                    "count": int(count),
                }
            )
        payload = {
            "type": "chart",
            "chart_type": "histogram",
            "name": str(name),
            "x": "bin_label",
            "y": "count",
            "value": value,
            "bins": bin_count,
            "points": points,
            "truncated": False,
        }
        self._add(payload)
        return payload

    def export_csv(self, data: Any = None, filename: str = "export.csv", name: str = "csv_export") -> Dict[str, Any]:
        frame = _frame_from_any(data if data is not None else self._frame)
        safe_name = _safe_export_filename(filename, ".csv")
        if not safe_name.lower().endswith(".csv"):
            safe_name = f"{Path(safe_name).stem}.csv"
        path = self._export_dir / safe_name
        self._export_dir.mkdir(parents=True, exist_ok=True)
        frame.to_csv(path, index=False)
        payload = self._export_payload(path, name=name, media_type="text/csv")
        self._add(payload)
        return payload

    def export_json(self, data: Any = None, filename: str = "export.json", name: str = "json_export") -> Dict[str, Any]:
        safe_name = _safe_export_filename(filename, ".json")
        if not safe_name.lower().endswith(".json"):
            safe_name = f"{Path(safe_name).stem}.json"
        path = self._export_dir / safe_name
        self._export_dir.mkdir(parents=True, exist_ok=True)
        payload_value = _json_safe(data if data is not None else self._frame)
        path.write_text(json.dumps(payload_value, indent=2, ensure_ascii=True), encoding="utf-8")
        payload = self._export_payload(path, name=name, media_type="application/json")
        self._add(payload)
        return payload

    def export_table(
        self,
        data: Any = None,
        filename: str = "table.csv",
        name: str = "table_export",
        format: str = "csv",
    ) -> Dict[str, Any]:
        normalized_format = str(format or "csv").strip().lower()
        if normalized_format == "json":
            return self.export_json(data=data, filename=filename, name=name)
        return self.export_csv(data=data, filename=filename, name=name)

    def pivot_variables(self, data: Any = None) -> pd.DataFrame:
        frame = _frame_from_any(data if data is not None else self._frame)
        required = {"date", "lat", "lon", "elev", "variable", "value"}
        missing = required - set(frame.columns)
        if missing:
            raise ValueError(f"pivot_variables missing columns: {sorted(missing)}")
        return (
            frame.pivot_table(
                index=["date", "lat", "lon", "elev"],
                columns="variable",
                values="value",
                aggfunc="mean",
            )
            .reset_index()
            .rename_axis(None, axis=1)
        )

    def _add(self, payload: Dict[str, Any]) -> None:
        max_outputs = int(self._limits.get("max_outputs") or 40)
        if len(self._outputs) >= max_outputs:
            raise RuntimeError(f"Output limit exceeded. Maximum outputs: {max_outputs}")
        self._outputs.append(payload)

    def _export_payload(self, path: Path, name: str, media_type: str) -> Dict[str, Any]:
        return {
            "type": "export_file",
            "name": str(name),
            "filename": path.name,
            "media_type": media_type,
            "size_bytes": int(path.stat().st_size),
            "download_url": f"/operations/jobs/{self._job_id}/exports/{path.name}",
        }


def _call_run_function(run_func: Any, hb: HBApi, frame: pd.DataFrame, meta: Dict[str, Any]) -> Any:
    signature = inspect.signature(run_func)
    param_count = len(signature.parameters)
    if param_count >= 3:
        return run_func(hb, frame, meta)
    if param_count == 2:
        return run_func(hb, frame)
    if param_count == 1:
        return run_func(frame)
    return run_func()


def _safe_builtins() -> Dict[str, Any]:
    return {
        "__build_class__": __build_class__,
        "__import__": _safe_import,
        "ArithmeticError": ArithmeticError,
        "Exception": Exception,
        "RuntimeError": RuntimeError,
        "ValueError": ValueError,
        "ZeroDivisionError": ZeroDivisionError,
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "callable": callable,
        "dict": dict,
        "enumerate": enumerate,
        "filter": filter,
        "float": float,
        "int": int,
        "isinstance": isinstance,
        "len": len,
        "list": list,
        "map": map,
        "max": max,
        "min": min,
        "pow": pow,
        "print": print,
        "range": range,
        "repr": repr,
        "reversed": reversed,
        "round": round,
        "set": set,
        "slice": slice,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "zip": zip,
    }


def main() -> int:
    payload = json.loads(sys.stdin.read())
    job_id = payload.get("job_id") or "job"
    code = payload["code"]
    frame_payload = payload["frame"]
    meta = payload.get("meta") or {}
    limits = payload.get("limits") or {}
    limits["timeout_seconds"] = payload.get("timeout_seconds")

    _apply_resource_limits(limits)

    frame = pd.DataFrame(data=frame_payload.get("data", []), columns=frame_payload.get("columns", []))
    outputs: List[Dict[str, Any]] = []
    hb = HBApi(outputs, limits, frame.copy(), Path.cwd() / "exports", str(job_id))

    stdout_buffer = LimitedBuffer(int(limits.get("max_stdout_chars") or 20000))
    stderr_buffer = LimitedBuffer(int(limits.get("max_stderr_chars") or 12000))

    globals_dict: Dict[str, Any] = {
        "__builtins__": _safe_builtins(),
        "__name__": "__hb_custom_operation__",
        "df": frame.copy(),
        "hb": hb,
        "math": math,
        "meta": meta,
        "np": np,
        "pd": pd,
        "statistics": statistics,
    }

    response: Dict[str, Any]
    try:
        compiled = compile(code, "<custom-operation>", "exec")
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            exec(compiled, globals_dict, globals_dict)
            result = None
            run_func = globals_dict.get("run")
            if callable(run_func):
                result = _call_run_function(run_func, hb, globals_dict["df"], meta)
            elif "result" in globals_dict:
                result = globals_dict.get("result")

        if result is not None:
            outputs.append({"type": "result", "name": "result", "value": _json_safe(result)})

        response = {
            "ok": True,
            "outputs": outputs,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
        }
    except Exception:
        response = {
            "ok": False,
            "outputs": outputs,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
            "error": traceback.format_exc(limit=8),
        }

    sys.__stdout__.write(json.dumps(response, ensure_ascii=True))
    sys.__stdout__.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
