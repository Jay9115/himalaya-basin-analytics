import contextlib
import inspect
import json
import math
import statistics
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

import numpy as np
import pandas as pd

from worker import (  # noqa: E402
    HBApi,
    LimitedBuffer,
    _apply_resource_limits,
    _json_safe,
    _safe_builtins,
)


class LargeFrameProxy:
    MESSAGE = (
        "Large operation mode does not load the full selection into df. "
        "Use hb.iter_data() for chunked scans, hb.aggregate(...) for grouped statistics, "
        "or hb.sample(max_rows=...) for a small preview."
    )

    def __getattr__(self, _name: str) -> Any:
        raise RuntimeError(self.MESSAGE)

    def __getitem__(self, _key: Any) -> Any:
        raise RuntimeError(self.MESSAGE)

    def __iter__(self) -> Iterator[Any]:
        raise RuntimeError(self.MESSAGE)

    def __len__(self) -> int:
        raise RuntimeError(self.MESSAGE)

    def __repr__(self) -> str:
        return "<large-mode df unavailable; use hb.iter_data() or hb.aggregate()>"


class LargeHBApi(HBApi):
    def __init__(
        self,
        outputs: List[Dict[str, Any]],
        limits: Dict[str, Any],
        manifest: Dict[str, Any],
        export_dir: Path,
        job_id: str,
        progress_path: Path,
    ) -> None:
        super().__init__(outputs, limits, pd.DataFrame(), export_dir, job_id)
        self._manifest = manifest
        self._progress_path = progress_path
        self._chunks = manifest.get("chunks", [])
        self._base_meta = manifest.get("meta", {})

    def iter_data(
        self,
        *,
        columns: Optional[Iterable[str]] = None,
        max_chunks: Optional[int] = None,
    ) -> Iterator[pd.DataFrame]:
        column_list = list(columns) if columns else None
        chunks = self._chunks[: int(max_chunks)] if max_chunks else self._chunks
        total = len(chunks)
        for index, item in enumerate(chunks):
            self._write_progress("worker_reading_chunk", index=index, total=total)
            frame = pd.read_parquet(item["path"])
            if column_list:
                keep = [column for column in column_list if column in frame.columns]
                frame = frame[keep]
            yield frame.copy()
        self._write_progress("worker_chunks_finished", index=total, total=total)

    def sample(self, max_rows: int = 10000) -> pd.DataFrame:
        limit = max(1, int(max_rows or 1))
        frames: List[pd.DataFrame] = []
        collected = 0
        for chunk in self.iter_data():
            remaining = limit - collected
            if remaining <= 0:
                break
            sample = chunk.head(remaining)
            frames.append(sample)
            collected += len(sample)
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)

    def to_frame(self, max_rows: int = 250000) -> pd.DataFrame:
        limit = max(1, int(max_rows or 1))
        frames: List[pd.DataFrame] = []
        collected = 0
        for chunk in self.iter_data():
            collected += len(chunk)
            if collected > limit:
                raise RuntimeError(
                    f"hb.to_frame() would exceed {limit} rows. Use hb.iter_data() or hb.aggregate(...) instead."
                )
            frames.append(chunk)
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)

    def aggregate(
        self,
        *,
        by: Optional[Any] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ) -> pd.DataFrame:
        by_columns = self._normalize_by(by)
        metric_map = self._normalize_metrics(metrics)
        accum: Dict[Any, Dict[str, Any]] = {}

        for chunk in self.iter_data():
            if chunk.empty:
                continue
            self._ensure_derived_columns(chunk, by_columns)
            missing_by = [column for column in by_columns if column not in chunk.columns]
            if missing_by:
                raise ValueError(f"aggregate missing group columns: {missing_by}")

            for column in metric_map:
                if column not in chunk.columns:
                    raise ValueError(f"aggregate missing metric column: {column}")
                chunk[column] = pd.to_numeric(chunk[column], errors="coerce")

            if by_columns:
                iterator = chunk.groupby(by_columns, dropna=False)
            else:
                iterator = [((), chunk)]

            for key, group in iterator:
                key_tuple = key if isinstance(key, tuple) else (key,)
                bucket = accum.setdefault(key_tuple, {})
                for column, operations in metric_map.items():
                    series = pd.to_numeric(group[column], errors="coerce").dropna()
                    prefix = str(column)
                    if "count" in operations:
                        bucket[f"{prefix}__count"] = bucket.get(f"{prefix}__count", 0) + int(series.count())
                    if "sum" in operations or "mean" in operations:
                        bucket[f"{prefix}__sum"] = bucket.get(f"{prefix}__sum", 0.0) + float(series.sum())
                        bucket[f"{prefix}__mean_count"] = bucket.get(f"{prefix}__mean_count", 0) + int(series.count())
                    if "min" in operations and not series.empty:
                        current = float(series.min())
                        previous = bucket.get(f"{prefix}__min")
                        bucket[f"{prefix}__min"] = current if previous is None else min(previous, current)
                    if "max" in operations and not series.empty:
                        current = float(series.max())
                        previous = bucket.get(f"{prefix}__max")
                        bucket[f"{prefix}__max"] = current if previous is None else max(previous, current)

        rows: List[Dict[str, Any]] = []
        for key_tuple, bucket in accum.items():
            row = {column: key_tuple[index] for index, column in enumerate(by_columns)}
            for column, operations in metric_map.items():
                prefix = str(column)
                if "count" in operations:
                    row[f"{prefix}_count"] = int(bucket.get(f"{prefix}__count", 0))
                if "sum" in operations:
                    row[f"{prefix}_sum"] = float(bucket.get(f"{prefix}__sum", 0.0))
                if "mean" in operations:
                    count = int(bucket.get(f"{prefix}__mean_count", 0))
                    row[f"{prefix}_mean"] = float(bucket.get(f"{prefix}__sum", 0.0) / count) if count else None
                if "min" in operations:
                    row[f"{prefix}_min"] = bucket.get(f"{prefix}__min")
                if "max" in operations:
                    row[f"{prefix}_max"] = bucket.get(f"{prefix}__max")
            rows.append(row)

        result = pd.DataFrame(rows)
        if by_columns and not result.empty:
            result = result.sort_values(by=by_columns).reset_index(drop=True)
        return result

    def _normalize_by(self, by: Optional[Any]) -> List[str]:
        if by is None:
            return []
        if isinstance(by, str):
            return [by]
        return [str(item) for item in by]

    def _normalize_metrics(self, metrics: Optional[Dict[str, Any]]) -> Dict[str, List[str]]:
        raw = metrics or {"value": "mean"}
        allowed = {"count", "sum", "mean", "min", "max"}
        output: Dict[str, List[str]] = {}
        for column, operations in raw.items():
            if isinstance(operations, str):
                normalized = [operations]
            else:
                normalized = list(operations)
            cleaned = []
            for operation in normalized:
                op = str(operation).strip().lower()
                if op not in allowed:
                    raise ValueError(f"Unsupported aggregate metric '{operation}'. Supported: {sorted(allowed)}")
                cleaned.append(op)
            output[str(column)] = list(dict.fromkeys(cleaned))
        return output

    def _ensure_derived_columns(self, frame: pd.DataFrame, by_columns: List[str]) -> None:
        if "year" in by_columns and "year" not in frame.columns and "date" in frame.columns:
            frame["year"] = frame["date"].astype(str).str.slice(0, 4).astype(int)
        if "month" in by_columns and "month" not in frame.columns and "date" in frame.columns:
            frame["month"] = frame["date"].astype(str).str.slice(0, 7)

    def _write_progress(self, phase: str, *, index: int, total: int) -> None:
        payload = {
            "phase": phase,
            "chunks_processed": int(index),
            "chunk_count": int(total),
            "percent": round((index / total) * 100, 2) if total else 100,
        }
        try:
            self._progress_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
        except Exception:
            pass


def _call_large_run_function(run_func: Any, hb: LargeHBApi, frame_proxy: LargeFrameProxy, meta: Dict[str, Any]) -> Any:
    signature = inspect.signature(run_func)
    params = list(signature.parameters.values())
    param_count = len(params)
    if param_count >= 3:
        return run_func(hb, frame_proxy, meta)
    if param_count == 2:
        second_name = params[1].name.lower()
        if second_name in {"meta", "context", "selection"}:
            return run_func(hb, meta)
        return run_func(hb, frame_proxy)
    if param_count == 1:
        first_name = params[0].name.lower()
        if first_name in {"hb", "api"}:
            return run_func(hb)
        if first_name in {"meta", "context", "selection"}:
            return run_func(meta)
        return run_func(frame_proxy)
    return run_func()


def main() -> int:
    payload = json.loads(sys.stdin.read())
    job_id = payload.get("job_id") or "job"
    code = payload["code"]
    limits = payload.get("limits") or {}
    limits["timeout_seconds"] = payload.get("timeout_seconds")
    manifest_path = Path(payload["manifest_path"])
    progress_path = Path(payload["progress_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    meta = payload.get("meta") or manifest.get("meta") or {}
    meta["large_mode"] = True
    meta["chunk_count"] = len(manifest.get("chunks", []))

    _apply_resource_limits(limits)

    outputs: List[Dict[str, Any]] = []
    hb = LargeHBApi(outputs, limits, manifest, Path.cwd() / "exports", str(job_id), progress_path)
    frame_proxy = LargeFrameProxy()
    stdout_buffer = LimitedBuffer(int(limits.get("max_stdout_chars") or 20000))
    stderr_buffer = LimitedBuffer(int(limits.get("max_stderr_chars") or 12000))

    globals_dict: Dict[str, Any] = {
        "__builtins__": _safe_builtins(),
        "__name__": "__hb_large_operation__",
        "df": frame_proxy,
        "hb": hb,
        "math": math,
        "meta": meta,
        "np": np,
        "pd": pd,
        "statistics": statistics,
    }

    response: Dict[str, Any]
    try:
        compiled = compile(code, "<large-custom-operation>", "exec")
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            exec(compiled, globals_dict, globals_dict)
            result = None
            run_func = globals_dict.get("run")
            if callable(run_func):
                result = _call_large_run_function(run_func, hb, frame_proxy, meta)
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
            "error": traceback.format_exc(limit=10),
        }

    sys.__stdout__.write(json.dumps(response, ensure_ascii=True))
    sys.__stdout__.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
