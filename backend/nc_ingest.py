"""
Separate utilities for NetCDF upload ingestion and parquet conversion.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


TIME_CANDIDATES = [
    "time",
    "Time",
    "TIME",
    "date",
    "Date",
    "DATE",
    "datetime",
    "Datetime",
    "TIMESTAMP",
    "Times",
    "XTIME",
]
LAT_CANDIDATES = [
    "latitude",
    "lat",
    "Latitude",
    "LAT",
    "nav_lat",
    "XLAT",
    "XLAT_M",
    "y",
    "Y",
]
LON_CANDIDATES = [
    "longitude",
    "lon",
    "Longitude",
    "LON",
    "nav_lon",
    "XLONG",
    "XLONG_M",
    "x",
    "X",
]
ELEV_CANDIDATES = [
    "elevation_m",
    "elevation",
    "elev",
    "altitude",
    "height",
    "z",
    "orog",
    "HGT",
    "HGT_M",
]
MANIFEST_VERSION = 1
FALLBACK_ELEVATION_M = 500.0
DATE_FROM_TEXT_PATTERN = re.compile(
    r"(?<!\d)((?:19|20)\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[T _-]?([0-2]\d)(?::?([0-5]\d))?(?::?([0-5]\d))?)?"
)
TIME_ATTR_CANDIDATES = [
    "time_coverage_start",
    "time_coverage_end",
    "start_time",
    "end_time",
    "reference_time",
    "analysis_time",
    "forecast_reference_time",
    "valid_time",
    "date_created",
    "date",
]


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return cleaned or "dataset"


def generate_dataset_id(dataset_name: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"nc_{slugify(dataset_name)}_{stamp}"


def _read_manifest(manifest_path: Path) -> Dict[str, Any]:
    if not manifest_path.exists():
        return {"version": MANIFEST_VERSION, "datasets": []}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {"version": MANIFEST_VERSION, "datasets": []}
    datasets = payload.get("datasets")
    if not isinstance(datasets, list):
        datasets = []
    return {
        "version": payload.get("version", MANIFEST_VERSION),
        "datasets": datasets,
    }


def _write_manifest(manifest_path: Path, payload: Dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def list_uploaded_dataset_configs(manifest_path: Path) -> Dict[str, Dict[str, Any]]:
    payload = _read_manifest(manifest_path)
    configs: Dict[str, Dict[str, Any]] = {}
    for entry in payload["datasets"]:
        dataset_id = str(entry.get("id") or "").strip()
        path_value = str(entry.get("path") or "").strip()
        label = str(entry.get("label") or "").strip()
        if not dataset_id or not path_value:
            continue
        dataset_path = Path(path_value)
        if not dataset_path.exists():
            continue
        configs[dataset_id] = {
            "label": label or f"NC Upload ({dataset_id})",
            "paths": [dataset_path],
            "source": "nc_upload",
        }
    return configs


def add_uploaded_dataset_entry(
    manifest_path: Path,
    dataset_id: str,
    label: str,
    dataset_path: Path,
    source_file: Path,
    conversion_summary: Dict[str, Any],
) -> None:
    payload = _read_manifest(manifest_path)
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    new_entry = {
        "id": dataset_id,
        "label": label,
        "path": str(dataset_path),
        "source_file": str(source_file),
        "created_at_utc": now_iso,
        "kind": "nc_upload",
        "summary": conversion_summary,
    }
    existing = payload["datasets"]
    existing = [entry for entry in existing if str(entry.get("id")) != dataset_id]
    existing.append(new_entry)
    payload["datasets"] = existing
    _write_manifest(manifest_path, payload)


def _find_first_name(dataset: Any, candidates: List[str]) -> Optional[str]:
    for name in candidates:
        if name in dataset.coords:
            return name
    for name in candidates:
        if name in dataset.variables:
            return name
    lowered = {name.lower(): name for name in dataset.variables}
    for name in candidates:
        if name.lower() in lowered:
            return lowered[name.lower()]
    return None


def _looks_like_time_units(units: Any) -> bool:
    if not isinstance(units, str):
        return False
    text = units.lower()
    if " since " not in text:
        return False
    return any(token in text for token in ("second", "minute", "hour", "day", "month", "year"))


def _find_time_name(dataset: Any) -> Optional[str]:
    found = _find_first_name(dataset, TIME_CANDIDATES)
    if found:
        return found

    for name in dataset.coords:
        coord = dataset.coords[name]
        attrs = coord.attrs or {}
        standard_name = str(attrs.get("standard_name", "")).lower()
        axis = str(attrs.get("axis", "")).upper()
        units = attrs.get("units")
        if standard_name == "time" or axis == "T" or _looks_like_time_units(units):
            return name
        if np.issubdtype(coord.dtype, np.datetime64):
            return name

    for name in dataset.variables:
        if name in dataset.coords:
            continue
        var = dataset.variables[name]
        attrs = var.attrs or {}
        standard_name = str(attrs.get("standard_name", "")).lower()
        axis = str(attrs.get("axis", "")).upper()
        units = attrs.get("units")
        if standard_name == "time" or axis == "T" or _looks_like_time_units(units):
            return name

    for dim_name in dataset.dims:
        if "time" in str(dim_name).lower():
            return str(dim_name)

    return None


def _find_coord_name_by_semantics(dataset: Any, kind: str) -> Optional[str]:
    target_standard = "latitude" if kind == "lat" else "longitude"
    target_axis = "Y" if kind == "lat" else "X"
    unit_tokens = ("degrees_north", "degree_north", "degrees_n") if kind == "lat" else ("degrees_east", "degree_east", "degrees_e")

    for container_name in ("coords", "variables"):
        container = getattr(dataset, container_name)
        for name in container:
            da = container[name]
            attrs = da.attrs or {}
            standard_name = str(attrs.get("standard_name", "")).lower()
            axis = str(attrs.get("axis", "")).upper()
            units = str(attrs.get("units", "")).lower()
            long_name = str(attrs.get("long_name", "")).lower()
            if standard_name == target_standard:
                return str(name)
            if axis == target_axis and np.issubdtype(da.dtype, np.number):
                return str(name)
            if any(token in units for token in unit_tokens):
                return str(name)
            if target_standard in long_name:
                return str(name)
    return None


def _find_lat_lon_names(dataset: Any) -> Tuple[Optional[str], Optional[str]]:
    lat_name = _find_first_name(dataset, LAT_CANDIDATES)
    lon_name = _find_first_name(dataset, LON_CANDIDATES)

    if not lat_name:
        lat_name = _find_coord_name_by_semantics(dataset, kind="lat")
    if not lon_name:
        lon_name = _find_coord_name_by_semantics(dataset, kind="lon")

    if lat_name and lon_name and lat_name == lon_name:
        return None, None
    return lat_name, lon_name


def _extract_datetime_from_text(text: str) -> Optional[pd.Timestamp]:
    match = DATE_FROM_TEXT_PATTERN.search(text)
    if not match:
        return None

    year, month, day, hour, minute, second = match.groups()
    try:
        ts = pd.Timestamp(
            datetime(
                int(year),
                int(month),
                int(day),
                int(hour or 0),
                int(minute or 0),
                int(second or 0),
            )
        )
    except Exception:
        return None
    return ts


def _infer_fallback_timestamp(nc_file: Path, dataset: Any) -> pd.Timestamp:
    for key in TIME_ATTR_CANDIDATES:
        value = dataset.attrs.get(key)
        if value is None:
            continue
        ts = _extract_datetime_from_text(str(value))
        if ts is not None:
            return ts

    for value in dataset.attrs.values():
        ts = _extract_datetime_from_text(str(value))
        if ts is not None:
            return ts

    name_match = _extract_datetime_from_text(nc_file.stem)
    if name_match is not None:
        return name_match

    mtime = datetime.fromtimestamp(nc_file.stat().st_mtime)
    return pd.Timestamp(mtime).normalize()


def _build_fallback_time_index(length: int, start_ts: pd.Timestamp) -> pd.DatetimeIndex:
    safe_len = max(1, int(length))
    return pd.DatetimeIndex([start_ts + timedelta(days=idx) for idx in range(safe_len)])


def _to_timestamps(values: Any) -> pd.DatetimeIndex:
    try:
        timestamps = pd.to_datetime(values, errors="coerce")
    except Exception:
        timestamps = pd.to_datetime([str(v) for v in values], errors="coerce")
    if isinstance(timestamps, pd.Series):
        timestamps = pd.DatetimeIndex(timestamps)
    return pd.DatetimeIndex(timestamps)


def _prepare_grid(
    dataset: Any,
    lat_name: str,
    lon_name: str,
) -> Tuple[Tuple[str, ...], np.ndarray, np.ndarray]:
    lat_da = dataset[lat_name]
    lon_da = dataset[lon_name]

    # Collapse higher dimensions (for example WRF-like Time, Y, X) to a 2D or 1D grid.
    def _reduce_coord_dims(da: Any) -> Any:
        reduced = da
        while reduced.ndim > 2:
            dim = reduced.dims[0]
            if reduced.sizes.get(dim, 0) < 1:
                raise ValueError(f"Coordinate '{da.name}' has empty dimension '{dim}'.")
            reduced = reduced.isel({dim: 0})
        return reduced

    lat_da = _reduce_coord_dims(lat_da)
    lon_da = _reduce_coord_dims(lon_da)
    lat = np.asarray(lat_da.values)
    lon = np.asarray(lon_da.values)

    if lat.ndim == 1 and lon.ndim == 1:
        lat_dim = lat_da.dims[0]
        lon_dim = lon_da.dims[0]
        lat_mesh, lon_mesh = np.meshgrid(lat, lon, indexing="ij")
        return (lat_dim, lon_dim), lat_mesh.reshape(-1), lon_mesh.reshape(-1)

    if lat.ndim == 2 and lon.ndim == 2 and lat.shape == lon.shape:
        dims = tuple(lat_da.dims)
        return dims, lat.reshape(-1), lon.reshape(-1)

    # Mixed representation fallback (2D lat + 1D lon) or (1D lat + 2D lon)
    if lat.ndim == 2 and lon.ndim == 1 and lat.shape[1] == lon.shape[0]:
        lon_mesh = np.broadcast_to(lon.reshape(1, -1), lat.shape)
        dims = tuple(lat_da.dims)
        return dims, lat.reshape(-1), lon_mesh.reshape(-1)

    if lat.ndim == 1 and lon.ndim == 2 and lon.shape[0] == lat.shape[0]:
        lat_mesh = np.broadcast_to(lat.reshape(-1, 1), lon.shape)
        dims = tuple(lon_da.dims)
        return dims, lat_mesh.reshape(-1), lon.reshape(-1)

    raise ValueError(
        f"Unsupported lat/lon shape: lat={lat.shape}, lon={lon.shape}. "
        "Expected 1D/1D, 2D/2D, 2D/1D, or 1D/2D grids."
    )


def _select_time_lat_lon_variables(
    dataset: Any,
    time_name: Optional[str],
    point_dims: Tuple[str, ...],
    exclude_names: Optional[set[str]] = None,
) -> Dict[str, Any]:
    excluded_vars = {name for name in (exclude_names or set()) if name}
    selected: Dict[str, Any] = {}
    for var_name, da in dataset.data_vars.items():
        if var_name in excluded_vars:
            continue
        if not all(dim in da.dims for dim in point_dims):
            continue
        if not np.issubdtype(da.dtype, np.number):
            continue

        excluded_dims = set(point_dims)
        if time_name:
            excluded_dims.add(time_name)
        extras = [dim for dim in da.dims if dim not in excluded_dims]
        processed = da
        for dim in extras:
            if processed.sizes.get(dim, 0) < 1:
                processed = None
                break
            processed = processed.isel({dim: 0})
        if processed is None:
            continue

        try:
            if time_name and time_name in processed.dims:
                processed = processed.transpose(time_name, *point_dims)
            else:
                processed = processed.transpose(*point_dims)
        except Exception:
            continue
        selected[var_name] = processed
    return selected


def _build_elevation_column(
    dataset: Any,
    point_dims: Tuple[str, ...],
    point_count: int,
    time_name: Optional[str],
) -> np.ndarray:
    elev_name = _find_first_name(dataset, ELEV_CANDIDATES)
    if not elev_name:
        return np.full(point_count, FALLBACK_ELEVATION_M, dtype=np.float64)

    elev = dataset[elev_name]
    if time_name and time_name in elev.dims:
        elev = elev.isel({time_name: 0})

    extras = [dim for dim in elev.dims if dim not in set(point_dims)]
    for dim in extras:
        if elev.sizes.get(dim, 0) < 1:
            return np.full(point_count, FALLBACK_ELEVATION_M, dtype=np.float64)
        elev = elev.isel({dim: 0})

    if not all(dim in elev.dims for dim in point_dims):
        return np.full(point_count, FALLBACK_ELEVATION_M, dtype=np.float64)

    elev = elev.transpose(*point_dims)
    values = np.asarray(elev.values, dtype=np.float64).reshape(-1)
    if values.size != point_count:
        return np.full(point_count, FALLBACK_ELEVATION_M, dtype=np.float64)
    if np.isfinite(values).any():
        return values
    return np.full(point_count, FALLBACK_ELEVATION_M, dtype=np.float64)


def convert_nc_to_parquet(
    nc_file: Path,
    output_dir: Path,
    dataset_prefix: str,
) -> Dict[str, Any]:
    try:
        import xarray as xr  # Optional dependency used only for NC ingestion.
    except Exception as exc:
        raise RuntimeError(
            "NetCDF ingestion requires 'xarray' (and a backend like netCDF4). "
            "Install with: pip install xarray netCDF4"
        ) from exc

    output_dir.mkdir(parents=True, exist_ok=True)

    with xr.open_dataset(nc_file, decode_cf=True) as ds:
        time_name = _find_time_name(ds)
        lat_name, lon_name = _find_lat_lon_names(ds)
        if not lat_name or not lon_name:
            raise ValueError(
                "Could not detect latitude/longitude coordinates in NetCDF. "
                "Expected names like lat/lon/latitude/longitude or CF-style coordinate metadata."
            )

        fallback_start = _infer_fallback_timestamp(nc_file, ds)
        time_source = "coordinate"
        if time_name:
            if time_name in ds.coords or time_name in ds.variables:
                raw_time_values = ds[time_name].values
                inferred_len = int(np.asarray(raw_time_values).shape[0]) if np.asarray(raw_time_values).ndim > 0 else 1
            elif time_name in ds.dims:
                inferred_len = int(ds.sizes.get(time_name, 0))
                raw_time_values = np.arange(inferred_len, dtype=np.int64)
            else:
                inferred_len = 0
                raw_time_values = []

            if inferred_len < 1:
                time_values = _build_fallback_time_index(1, fallback_start)
                time_name = None
                time_source = "fallback_single_date"
            else:
                time_values = _to_timestamps(raw_time_values)
                if len(time_values) != inferred_len:
                    time_values = _build_fallback_time_index(inferred_len, fallback_start)
                    time_source = "fallback_generated_sequence"
                elif time_values.isna().all():
                    time_values = _build_fallback_time_index(inferred_len, fallback_start)
                    time_source = "fallback_generated_sequence"
                elif time_values.isna().any():
                    base_ts = next((ts for ts in time_values if not pd.isna(ts)), fallback_start)
                    filled = [
                        pd.Timestamp(ts).tz_localize(None) if not pd.isna(ts) else pd.Timestamp(base_ts) + timedelta(days=idx)
                        for idx, ts in enumerate(time_values)
                    ]
                    time_values = pd.DatetimeIndex(filled)
                    time_source = "coordinate_with_gaps_filled"
        else:
            time_values = _build_fallback_time_index(1, fallback_start)
            time_source = "fallback_single_date"

        point_dims, lat_flat, lon_flat = _prepare_grid(ds, lat_name, lon_name)
        point_count = lat_flat.size
        if point_count == 0:
            raise ValueError("NetCDF has empty spatial grid.")

        variable_map = _select_time_lat_lon_variables(
            ds,
            time_name,
            point_dims,
            exclude_names={lat_name, lon_name, time_name},
        )
        if not variable_map:
            requested_dims = " + ".join([*(["time"] if time_name else []), *point_dims])
            raise ValueError(
                "No numeric variables matched spatial coordinates. "
                f"Expected variables with dimensions containing {requested_dims}."
            )

        elevation_flat = _build_elevation_column(ds, point_dims, point_count, time_name)

        writers: Dict[Tuple[int, str], pq.ParquetWriter] = {}
        output_files: Dict[Tuple[int, str], Path] = {}
        rows_per_file: Dict[str, int] = {}
        total_rows = 0
        date_min: Optional[pd.Timestamp] = None
        date_max: Optional[pd.Timestamp] = None

        try:
            for t_idx, timestamp in enumerate(time_values):
                if pd.isna(timestamp):
                    continue
                ts = pd.Timestamp(timestamp).tz_localize(None)
                date_value = pd.Timestamp(ts.date())
                year = int(date_value.year)
                half = "H1" if int(date_value.month) <= 6 else "H2"
                key = (year, half)

                data: Dict[str, Any] = {
                    "date": np.full(point_count, np.datetime64(date_value), dtype="datetime64[ns]"),
                    "latitude": lat_flat,
                    "longitude": lon_flat,
                    "elevation_m": elevation_flat,
                }

                for var_name, da in variable_map.items():
                    if time_name and time_name in da.dims:
                        time_size = int(da.sizes.get(time_name, 0))
                        if time_size < 1:
                            continue
                        pick_idx = min(t_idx, time_size - 1)
                        selected = da.isel({time_name: pick_idx})
                    else:
                        selected = da
                    arr = np.asarray(selected.values, dtype=np.float64).reshape(-1)
                    if arr.size != point_count:
                        raise ValueError(
                            f"Variable '{var_name}' shape mismatch at index {t_idx}: "
                            f"expected {point_count}, got {arr.size}"
                        )
                    data[var_name] = arr

                value_cols = [name for name in data.keys() if name not in {"date", "latitude", "longitude", "elevation_m"}]
                if not value_cols:
                    continue

                frame = pd.DataFrame(data)
                valid_geo = np.isfinite(frame["latitude"].to_numpy()) & np.isfinite(frame["longitude"].to_numpy())
                if not valid_geo.any():
                    continue
                frame = frame.loc[valid_geo].copy()
                if frame.empty:
                    continue

                value_matrix = frame[value_cols].to_numpy(dtype=np.float64, copy=False)
                has_any_value = np.isfinite(value_matrix).any(axis=1)
                if not has_any_value.any():
                    continue
                frame = frame.loc[has_any_value].copy()
                if frame.empty:
                    continue

                table = pa.Table.from_pandas(frame, preserve_index=False)

                if key not in writers:
                    file_path = output_dir / f"{dataset_prefix}_{year}_{half}.parquet"
                    output_files[key] = file_path
                    writers[key] = pq.ParquetWriter(str(file_path), table.schema, compression="snappy")
                    rows_per_file[file_path.name] = 0

                writers[key].write_table(table)
                rows_written = len(frame)
                rows_per_file[output_files[key].name] += rows_written
                total_rows += rows_written
                date_min = date_value if date_min is None else min(date_min, date_value)
                date_max = date_value if date_max is None else max(date_max, date_value)
        finally:
            for writer in writers.values():
                writer.close()

    generated_files = sorted(path.name for path in output_files.values())
    if not generated_files:
        raise ValueError("NetCDF conversion produced no parquet rows.")

    years = sorted({int(name.split("_")[-2]) for name in generated_files})
    return {
        "parquet_files": generated_files,
        "rows_total": int(total_rows),
        "variables": sorted(variable_map.keys()),
        "years": years,
        "date_min": date_min.strftime("%Y-%m-%d") if date_min is not None else None,
        "date_max": date_max.strftime("%Y-%m-%d") if date_max is not None else None,
        "rows_per_file": rows_per_file,
        "grid_point_count": int(point_count),
        "time_coordinate": time_name,
        "time_source": time_source,
        "lat_coordinate": lat_name,
        "lon_coordinate": lon_name,
    }
