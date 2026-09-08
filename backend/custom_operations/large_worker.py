import contextlib
import inspect
import json
import math
import os
import re
import statistics
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

import numpy as np
import pandas as pd

try:
    import duckdb
except Exception:  # pragma: no cover - surfaced as a worker error with install guidance
    duckdb = None

from worker import (  # noqa: E402
    HBApi,
    LimitedBuffer,
    _apply_resource_limits,
    _json_safe,
    _safe_builtins,
    _safe_export_filename,
)


DEFAULT_MAX_RESULT_ROWS = 250_000
DEFAULT_BATCH_ROWS = 250_000
BLOCKED_SQL_ACCESS = re.compile(
    r"(?i)(?:"
    r"\b(?:current_setting|duckdb_[a-z0-9_]*|glob|information_schema|pg_catalog|pragma_[a-z0-9_]*|"
    r"parquet_metadata|parquet_schema|query|query_table|sqlite_master|which_secret)\b"
    r"|\b(?:read|scan)_[a-z0-9_]*\s*\("
    r"|\b(?:from|join)\s*['\"]"
    r")"
)


def _quote_identifier(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _quote_string(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _date_start(value: str) -> str:
    return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d 00:00:00")


def _date_after(value: str) -> str:
    parsed = datetime.strptime(value, "%Y-%m-%d") + timedelta(days=1)
    return parsed.strftime("%Y-%m-%d 00:00:00")


def _points_in_ring(lons: np.ndarray, lats: np.ndarray, ring: np.ndarray) -> np.ndarray:
    inside = np.zeros(lons.shape[0], dtype=bool)
    if ring.ndim != 2 or ring.shape[0] < 4 or ring.shape[1] < 2:
        return inside
    x = ring[:, 0]
    y = ring[:, 1]
    eps = 1e-12
    for index in range(len(ring) - 1):
        xi = x[index]
        yi = y[index]
        xj = x[index + 1]
        yj = y[index + 1]
        intersects = ((yi > lats) != (yj > lats)) & (
            lons < (xj - xi) * (lats - yi) / ((yj - yi) + eps) + xi
        )
        inside ^= intersects
    return inside


def _points_in_subregion(lons: np.ndarray, lats: np.ndarray, subregion: Dict[str, Any]) -> np.ndarray:
    output = np.zeros(lons.shape[0], dtype=bool)
    for polygon in subregion.get("polygons") or []:
        outer = np.asarray(polygon.get("outer") or [], dtype=np.float64)
        polygon_inside = _points_in_ring(lons, lats, outer)
        for raw_hole in polygon.get("holes") or []:
            hole = np.asarray(raw_hole or [], dtype=np.float64)
            polygon_inside &= ~_points_in_ring(lons, lats, hole)
        output |= polygon_inside
    return output


class LargeFrameProxy:
    MESSAGE = (
        "Large operation mode exposes a lazy data source, not an eager pandas dataframe. "
        "Use hb.sql(...), hb.aggregate(...), hb.iter_data(), hb.sample(...), "
        "hb.to_frame(max_rows=...), or hb.export_query(...)."
    )

    def __init__(self, hb: "LargeHBApi", columns: Iterable[str]) -> None:
        self._hb = hb
        self._columns = pd.Index(list(dict.fromkeys(str(item) for item in columns)))

    @property
    def columns(self) -> pd.Index:
        return self._columns.copy()

    def sql(self, query: str, params: Optional[Any] = None, max_rows: int = DEFAULT_MAX_RESULT_ROWS) -> pd.DataFrame:
        return self._hb.sql(query, params=params, max_rows=max_rows)

    def sample(self, max_rows: int = 10_000) -> pd.DataFrame:
        return self._hb.sample(max_rows=max_rows)

    def to_frame(self, max_rows: int = DEFAULT_MAX_RESULT_ROWS) -> pd.DataFrame:
        return self._hb.to_frame(max_rows=max_rows)

    def __getattr__(self, _name: str) -> Any:
        raise RuntimeError(self.MESSAGE)

    def __getitem__(self, _key: Any) -> Any:
        raise RuntimeError(self.MESSAGE)

    def __iter__(self) -> Iterator[Any]:
        raise RuntimeError(self.MESSAGE)

    def __len__(self) -> int:
        raise RuntimeError(self.MESSAGE)

    def __repr__(self) -> str:
        return "<lazy HB data relation; query with hb.sql() or hb.aggregate()>"


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
        self._source = manifest.get("source") or {}
        self._data_local = manifest.get("mode") == "data_local" and self._source.get("kind") == "parquet"
        self._connection = None
        self._logical_columns = list(self._source.get("logical_columns") or [])
        if self._data_local:
            self._initialize_data_local_engine()

    @property
    def logical_columns(self) -> List[str]:
        if self._logical_columns:
            return list(dict.fromkeys(str(item) for item in self._logical_columns))
        if self._chunks:
            return list(self._chunks[0].get("columns") or [])
        return ["dataset", "date", "lat", "lon", "elev", "variable", "value"]

    def close(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            finally:
                self._connection = None

    def sql(
        self,
        query: str,
        params: Optional[Any] = None,
        max_rows: int = DEFAULT_MAX_RESULT_ROWS,
    ) -> pd.DataFrame:
        if not self._data_local or self._connection is None:
            raise RuntimeError("hb.sql() requires a data-local Parquet selection.")
        normalized = self._validate_select_query(query)
        limit = self._bounded_result_limit(max_rows)
        wrapped = f"SELECT * FROM ({normalized}) AS _hb_bounded_result LIMIT {limit + 1}"
        self._write_progress("query_running", index=0, total=1)
        frame = self._connection.execute(wrapped, params or []).fetchdf()
        if len(frame) > limit:
            raise RuntimeError(
                f"Query result exceeds the in-memory limit of {limit:,} rows. "
                "Aggregate further, use hb.iter_data() for batches, or hb.export_query() for a full artifact."
            )
        self._write_progress("query_finished", index=1, total=1, result_rows=len(frame))
        return frame

    def export_query(
        self,
        query: str,
        *,
        filename: str = "query.csv",
        name: str = "query_export",
        format: str = "csv",
        params: Optional[Any] = None,
    ) -> Dict[str, Any]:
        if not self._data_local or self._connection is None:
            raise RuntimeError("hb.export_query() requires a data-local Parquet selection.")
        normalized = self._validate_select_query(query)
        export_format = str(format or "csv").strip().lower()
        if export_format not in {"csv", "parquet"}:
            raise ValueError("hb.export_query format must be 'csv' or 'parquet'.")
        suffix = ".csv" if export_format == "csv" else ".parquet"
        safe_name = _safe_export_filename(filename, suffix)
        if Path(safe_name).suffix.lower() != suffix:
            safe_name = f"{Path(safe_name).stem}{suffix}"
        self._export_dir.mkdir(parents=True, exist_ok=True)
        path = self._export_dir / safe_name
        relation = self._connection.sql(normalized, params=params or None)
        self._write_progress("export_running", index=0, total=1)
        if export_format == "csv":
            relation.write_csv(str(path), header=True)
            media_type = "text/csv"
        else:
            relation.write_parquet(str(path), compression="zstd")
            media_type = "application/vnd.apache.parquet"
        self._write_progress("export_finished", index=1, total=1)
        payload = self._export_payload(path, name=name, media_type=media_type)
        self._add(payload)
        return payload

    def iter_data(
        self,
        *,
        columns: Optional[Iterable[str]] = None,
        max_chunks: Optional[int] = None,
        batch_rows: int = DEFAULT_BATCH_ROWS,
    ) -> Iterator[pd.DataFrame]:
        if self._data_local and self._connection is not None:
            column_list = self._validated_columns(columns)
            projection = ", ".join(_quote_identifier(column) for column in column_list) if column_list else "*"
            rows_per_batch = max(1, min(int(batch_rows or DEFAULT_BATCH_ROWS), 1_000_000))
            reader = self._connection.execute(f"SELECT {projection} FROM data").fetch_record_batch(rows_per_batch)
            processed = 0
            for batch in reader:
                if max_chunks is not None and processed >= int(max_chunks):
                    break
                self._write_progress("worker_reading_batch", index=processed, total=0)
                processed += 1
                yield batch.to_pandas()
            self._write_progress("worker_batches_finished", index=processed, total=processed)
            return

        column_list = list(columns) if columns else None
        chunks = self._chunks[: int(max_chunks)] if max_chunks else self._chunks
        total = len(chunks)
        for index, item in enumerate(chunks):
            self._write_progress("worker_reading_chunk", index=index, total=total)
            frame = pd.read_parquet(item["path"])
            if column_list:
                keep = [column for column in column_list if column in frame.columns]
                frame = frame[keep]
            yield frame
        self._write_progress("worker_chunks_finished", index=total, total=total)

    def sample(self, max_rows: int = 10_000) -> pd.DataFrame:
        limit = max(1, min(int(max_rows or 1), self._bounded_result_limit(DEFAULT_MAX_RESULT_ROWS)))
        if self._data_local:
            return self.sql(f"SELECT * FROM data LIMIT {limit}", max_rows=limit)
        frames: List[pd.DataFrame] = []
        collected = 0
        for chunk in self.iter_data():
            remaining = limit - collected
            if remaining <= 0:
                break
            frames.append(chunk.head(remaining))
            collected += min(len(chunk), remaining)
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

    def to_frame(self, max_rows: int = DEFAULT_MAX_RESULT_ROWS) -> pd.DataFrame:
        limit = self._bounded_result_limit(max_rows)
        if self._data_local and self._connection is not None:
            frame = self._connection.execute(f"SELECT * FROM data LIMIT {limit + 1}").fetchdf()
            if len(frame) > limit:
                raise RuntimeError(
                    f"hb.to_frame() would exceed {limit:,} rows. Use hb.sql(), hb.aggregate(), "
                    "hb.iter_data(), or hb.export_query() instead."
                )
            return frame

        frames: List[pd.DataFrame] = []
        collected = 0
        for chunk in self.iter_data():
            collected += len(chunk)
            if collected > limit:
                raise RuntimeError(
                    f"hb.to_frame() would exceed {limit:,} rows. Use hb.iter_data() or hb.aggregate(...) instead."
                )
            frames.append(chunk)
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

    def aggregate(
        self,
        *,
        by: Optional[Any] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ) -> pd.DataFrame:
        by_columns = self._normalize_by(by)
        metric_map = self._normalize_metrics(metrics)
        if self._data_local:
            return self._aggregate_data_local(by_columns, metric_map)
        return self._aggregate_chunks(by_columns, metric_map)

    def _aggregate_data_local(
        self,
        by_columns: List[str],
        metric_map: Dict[str, List[str]],
    ) -> pd.DataFrame:
        available = set(self.logical_columns)
        group_expressions: List[str] = []
        group_aliases: List[str] = []
        for column in by_columns:
            if column == "year":
                group_expressions.append("year(date)::INTEGER AS year")
                group_aliases.append("year")
            elif column == "month":
                group_expressions.append("strftime(date, '%Y-%m') AS month")
                group_aliases.append("month")
            elif column in available:
                group_expressions.append(_quote_identifier(column))
                group_aliases.append(column)
            else:
                raise ValueError(f"aggregate missing group column: {column}")

        metric_expressions: List[str] = []
        operation_sql = {"count": "count", "sum": "sum", "mean": "avg", "min": "min", "max": "max"}
        for column, operations in metric_map.items():
            if column not in available:
                raise ValueError(f"aggregate missing metric column: {column}")
            quoted = _quote_identifier(column)
            for operation in operations:
                alias = _quote_identifier(f"{column}_{operation}")
                metric_expressions.append(f"{operation_sql[operation]}({quoted}) AS {alias}")

        select_items = group_expressions + metric_expressions
        if not select_items:
            raise ValueError("aggregate requires at least one group or metric expression")
        query = f"SELECT {', '.join(select_items)} FROM data"
        if group_aliases:
            quoted_groups = ", ".join(_quote_identifier(item) for item in group_aliases)
            query += f" GROUP BY {quoted_groups} ORDER BY {quoted_groups}"
        return self.sql(query)

    def _aggregate_chunks(
        self,
        by_columns: List[str],
        metric_map: Dict[str, List[str]],
    ) -> pd.DataFrame:
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
            iterator = chunk.groupby(by_columns, dropna=False) if by_columns else [((), chunk)]
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

    def _initialize_data_local_engine(self) -> None:
        if duckdb is None:
            raise RuntimeError("Data-local execution requires the 'duckdb' backend dependency.")
        files = [str(Path(item).resolve()) for item in self._source.get("files") or []]
        if not files:
            raise RuntimeError("Data-local manifest contains no Parquet files.")
        export_dir = self._export_dir.resolve()
        temp_dir = (export_dir.parent / "duckdb_tmp").resolve()
        export_dir.mkdir(parents=True, exist_ok=True)
        temp_dir.mkdir(parents=True, exist_ok=True)

        connection = duckdb.connect(database=":memory:")
        self._connection = connection
        memory_mb = max(128, int(self._limits.get("memory_mb") or 1024))
        worker_threads = max(1, min(int(os.cpu_count() or 1), 8))
        connection.execute("SET threads = ?", [worker_threads])
        connection.execute("SET memory_limit = ?", [f"{max(128, int(memory_mb * 0.75))}MB"])
        connection.execute("SET temp_directory = ?", [str(temp_dir)])
        connection.execute("SET preserve_insertion_order = false")
        connection.execute("SET allowed_paths = ?", [files])
        connection.execute("SET allowed_directories = ?", [[str(export_dir), str(temp_dir)]])
        for setting in ("autoinstall_known_extensions", "autoload_known_extensions", "allow_community_extensions"):
            try:
                connection.execute(f"SET {setting} = false")
            except Exception:
                pass
        connection.execute("SET enable_external_access = false")

        scan_sql = self._parquet_scan_sql(files)
        region_clause = self._prepare_region_filter(scan_sql)
        view_sql = self._normalized_view_sql(scan_sql, region_clause)
        connection.execute(f"CREATE TEMP VIEW data AS {view_sql}")
        try:
            connection.execute("SET lock_configuration = true")
        except Exception:
            pass
        self._write_progress(
            "data_source_ready",
            index=1,
            total=1,
            source_file_count=len(files),
            engine="duckdb",
        )

    def _parquet_scan_sql(self, files: List[str]) -> str:
        file_list = ", ".join(_quote_string(item.replace("\\", "/")) for item in files)
        return f"read_parquet([{file_list}], union_by_name=true)"

    def _normalized_view_sql(self, scan_sql: str, region_clause: str) -> str:
        columns = self._source.get("physical_columns") or {}
        date_col = _quote_identifier(columns["date"])
        lat_col = _quote_identifier(columns["lat"])
        lon_col = _quote_identifier(columns["lon"])
        elev_col = _quote_identifier(columns["elev"])
        dataset = _quote_string(str(self._source.get("dataset") or "dataset"))
        where_sql = self._source_filter_sql(date_col, lat_col, lon_col, elev_col, region_clause)
        selected_variables = list(self._source.get("variables") or [])
        if not selected_variables:
            raise RuntimeError("Data-local manifest contains no selected variables.")

        if len(selected_variables) > 1:
            value_columns = []
            value_rows = []
            variable_projections = []
            for index, variable in enumerate(selected_variables):
                name = str(variable["name"])
                value_col = _quote_identifier(str(variable["column"]))
                internal_alias = _quote_identifier(f"_hb_value_{index}")
                value_columns.append(f"TRY_CAST({value_col} AS DOUBLE) AS {internal_alias}")
                value_rows.append(f"({_quote_string(name)}, _hb_source.{internal_alias})")
                if name not in {"dataset", "date", "lat", "lon", "elev", "variable", "value"}:
                    variable_projections.append(
                        f"CASE WHEN _hb_values.variable = {_quote_string(name)} "
                        f"THEN _hb_values.value ELSE NULL END AS {_quote_identifier(name)}"
                    )
            return (
                "WITH _hb_source AS (SELECT "
                f"TRY_CAST({date_col} AS TIMESTAMP) AS _hb_date, "
                f"TRY_CAST({lat_col} AS DOUBLE) AS _hb_lat, "
                f"TRY_CAST({lon_col} AS DOUBLE) AS _hb_lon, "
                f"TRY_CAST({elev_col} AS DOUBLE) AS _hb_elev, "
                f"{', '.join(value_columns)} FROM {scan_sql} WHERE {where_sql}) "
                f"SELECT {dataset} AS dataset, _hb_source._hb_date AS date, "
                "_hb_source._hb_lat AS lat, _hb_source._hb_lon AS lon, "
                "_hb_source._hb_elev AS elev, _hb_values.variable, _hb_values.value"
                f"{', ' if variable_projections else ' '}{', '.join(variable_projections)} "
                "FROM _hb_source CROSS JOIN LATERAL (VALUES "
                f"{', '.join(value_rows)}) AS _hb_values(variable, value)"
            )

        selects = []
        for variable in selected_variables:
            name = str(variable["name"])
            value_col = _quote_identifier(str(variable["column"]))
            name_literal = _quote_string(name)
            variable_projections = []
            for projected in selected_variables:
                projected_name = str(projected["name"])
                if projected_name in {"dataset", "date", "lat", "lon", "elev", "variable", "value"}:
                    continue
                projected_alias = _quote_identifier(projected_name)
                if projected_name == name:
                    variable_projections.append(f"TRY_CAST({value_col} AS DOUBLE) AS {projected_alias}")
                else:
                    variable_projections.append(f"NULL::DOUBLE AS {projected_alias}")
            selects.append(
                "SELECT "
                f"{dataset} AS dataset, "
                f"TRY_CAST({date_col} AS TIMESTAMP) AS date, "
                f"TRY_CAST({lat_col} AS DOUBLE) AS lat, "
                f"TRY_CAST({lon_col} AS DOUBLE) AS lon, "
                f"TRY_CAST({elev_col} AS DOUBLE) AS elev, "
                f"{name_literal} AS variable, "
                f"TRY_CAST({value_col} AS DOUBLE) AS value"
                f"{', ' if variable_projections else ' '}{', '.join(variable_projections)} "
                f"FROM {scan_sql} WHERE {where_sql}"
            )
        return " UNION ALL ".join(selects)

    def _source_filter_sql(
        self,
        date_col: str,
        lat_col: str,
        lon_col: str,
        elev_col: str,
        region_clause: str,
    ) -> str:
        filters = self._source.get("filter") or {}
        date_filter = filters.get("date") or {}
        date_expression = f"TRY_CAST({date_col} AS TIMESTAMP)"
        elevation_expression = f"TRY_CAST({elev_col} AS DOUBLE)"
        clauses = []
        if date_filter.get("mode") == "list":
            dates = [str(item) for item in date_filter.get("dates") or []]
            if not dates:
                clauses.append("false")
            else:
                date_values = ", ".join(f"DATE {_quote_string(item)}" for item in dates)
                clauses.append(f"CAST({date_expression} AS DATE) IN ({date_values})")
        else:
            start = str(date_filter["start"])
            end = str(date_filter["end"])
            clauses.append(f"{date_expression} >= TIMESTAMP {_quote_string(_date_start(start))}")
            clauses.append(f"{date_expression} < TIMESTAMP {_quote_string(_date_after(end))}")
        clauses.append(f"{elevation_expression} >= {float(filters['elev_min'])}")
        clauses.append(f"{elevation_expression} <= {float(filters['elev_max'])}")
        subregion = self._source.get("subregion")
        if subregion:
            bounds = subregion["bounds"]
            clauses.extend(
                [
                    f"TRY_CAST({lat_col} AS DOUBLE) >= {float(bounds['min_lat'])}",
                    f"TRY_CAST({lat_col} AS DOUBLE) <= {float(bounds['max_lat'])}",
                    f"TRY_CAST({lon_col} AS DOUBLE) >= {float(bounds['min_lon'])}",
                    f"TRY_CAST({lon_col} AS DOUBLE) <= {float(bounds['max_lon'])}",
                ]
            )
        if region_clause:
            clauses.append(region_clause)
        return " AND ".join(clauses)

    def _prepare_region_filter(self, scan_sql: str) -> str:
        subregion = self._source.get("subregion")
        if not subregion:
            return ""
        if not subregion.get("polygons"):
            raise RuntimeError("Selected subregion has no polygon geometry.")
        columns = self._source.get("physical_columns") or {}
        lat_col = _quote_identifier(columns["lat"])
        lon_col = _quote_identifier(columns["lon"])
        elev_col = _quote_identifier(columns["elev"])
        bounds = subregion["bounds"]
        filters = self._source.get("filter") or {}
        representative = str(Path(self._source["representative_file"]).resolve()).replace("\\", "/")
        representative_scan = f"read_parquet({_quote_string(representative)})"
        coordinate_query = (
            f"SELECT DISTINCT TRY_CAST({lon_col} AS DOUBLE) AS lon, TRY_CAST({lat_col} AS DOUBLE) AS lat "
            f"FROM {representative_scan} "
            f"WHERE TRY_CAST({lat_col} AS DOUBLE) >= {float(bounds['min_lat'])} "
            f"AND TRY_CAST({lat_col} AS DOUBLE) <= {float(bounds['max_lat'])} "
            f"AND TRY_CAST({lon_col} AS DOUBLE) >= {float(bounds['min_lon'])} "
            f"AND TRY_CAST({lon_col} AS DOUBLE) <= {float(bounds['max_lon'])} "
            f"AND TRY_CAST({elev_col} AS DOUBLE) >= {float(filters['elev_min'])} "
            f"AND TRY_CAST({elev_col} AS DOUBLE) <= {float(filters['elev_max'])}"
        )
        coordinates = self._connection.execute(coordinate_query).fetchdf()
        if coordinates.empty:
            selected = coordinates
        else:
            lons = coordinates["lon"].to_numpy(dtype=np.float64, copy=False)
            lats = coordinates["lat"].to_numpy(dtype=np.float64, copy=False)
            mask = _points_in_subregion(lons, lats, subregion)
            selected = coordinates.loc[mask, ["lat", "lon"]]
        self._connection.execute("CREATE TEMP TABLE _hb_region_points(lat DOUBLE, lon DOUBLE)")
        if not selected.empty:
            self._connection.executemany(
                "INSERT INTO _hb_region_points VALUES (?, ?)",
                list(selected.itertuples(index=False, name=None)),
            )
        lat_physical = _quote_identifier(columns["lat"])
        lon_physical = _quote_identifier(columns["lon"])
        return (
            "EXISTS (SELECT 1 FROM _hb_region_points AS _hb_rp "
            f"WHERE _hb_rp.lat = CAST({lat_physical} AS DOUBLE) "
            f"AND _hb_rp.lon = CAST({lon_physical} AS DOUBLE))"
        )

    def _validate_select_query(self, query: str) -> str:
        text = str(query or "").strip()
        if not text:
            raise ValueError("hb.sql() requires a non-empty SELECT query.")
        if self._connection is None:
            raise RuntimeError("Data-local query engine is not initialized.")
        statements = self._connection.extract_statements(text)
        if len(statements) != 1 or str(statements[0].type) != "StatementType.SELECT":
            raise ValueError("Only one read-only SELECT/WITH statement is allowed.")
        normalized = statements[0].query.rstrip().rstrip(";")
        if BLOCKED_SQL_ACCESS.search(normalized):
            raise ValueError(
                "Queries may use only the normalized data view and query-local CTEs; "
                "filesystem readers and engine catalogs/settings are not available."
            )
        return normalized

    def _bounded_result_limit(self, requested: int) -> int:
        platform_limit = int(self._limits.get("max_result_rows") or DEFAULT_MAX_RESULT_ROWS)
        return max(1, min(int(requested or platform_limit), platform_limit))

    def _validated_columns(self, columns: Optional[Iterable[str]]) -> List[str]:
        if not columns:
            return []
        available = set(self.logical_columns)
        values = [str(item) for item in columns]
        missing = [item for item in values if item not in available]
        if missing:
            raise ValueError(f"Unknown data columns: {missing}")
        return list(dict.fromkeys(values))

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
            normalized = [operations] if isinstance(operations, str) else list(operations)
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

    def _write_progress(self, phase: str, *, index: int, total: int, **extra: Any) -> None:
        payload = {
            "phase": phase,
            "batches_processed": int(index),
            "batch_count": int(total),
            "percent": round((index / total) * 100, 2) if total else None,
            **extra,
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
    meta["execution_model"] = "data_local_lazy" if manifest.get("mode") == "data_local" else "chunked_fallback"

    _apply_resource_limits(limits)
    outputs: List[Dict[str, Any]] = []
    stdout_buffer = LimitedBuffer(int(limits.get("max_stdout_chars") or 20000))
    stderr_buffer = LimitedBuffer(int(limits.get("max_stderr_chars") or 12000))
    hb: Optional[LargeHBApi] = None

    try:
        hb = LargeHBApi(outputs, limits, manifest, Path.cwd() / "exports", str(job_id), progress_path)
        frame_proxy = LargeFrameProxy(hb, hb.logical_columns)
        globals_dict: Dict[str, Any] = {
            "__builtins__": _safe_builtins(),
            "__name__": "__hb_large_operation__",
            "data": frame_proxy,
            "df": frame_proxy,
            "hb": hb,
            "math": math,
            "meta": meta,
            "np": np,
            "pd": pd,
            "statistics": statistics,
        }
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
            "error": traceback.format_exc(limit=12),
        }
    finally:
        if hb is not None:
            hb.close()

    sys.__stdout__.write(json.dumps(response, ensure_ascii=True))
    sys.__stdout__.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
