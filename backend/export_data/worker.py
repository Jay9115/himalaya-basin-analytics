"""
Export worker — background job logic for temporal CSV and spatial map exports.

This module is designed to run heavy I/O (parquet reads, rasterio writes, CSV
writes) in a background thread so the FastAPI event loop stays responsive.

All data access goes through the OperationBackendHooks / OperationDataLoader
that are already shared by the custom_operations module — no direct coupling
to main.py internals.
"""

import csv
import io
import json
import logging
import shutil
import threading
import time
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from custom_operations.data_access import OperationBackendHooks

from .schemas import ExportProgress, ExportRequest

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Job registry — tracks running / finished export jobs in-process
# ---------------------------------------------------------------------------

_JOBS_LOCK = threading.Lock()
_JOBS: Dict[str, Dict[str, Any]] = {}
_MAX_FINISHED_JOBS = 50


def _register_job(job_id: str, request: ExportRequest) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "id": job_id,
        "request": request,
        "status": "queued",
        "progress_percent": 0,
        "message": "Queued",
        "files_generated": 0,
        "total_files_expected": 0,
        "download_ready": False,
        "download_path": None,
        "error": None,
        "created_at": datetime.utcnow().isoformat(),
        "thread": None,
        "cancel_event": threading.Event(),
        "relative_files": [],
        "output_dir": None,
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = entry
        # Evict oldest finished jobs when the registry grows too large.
        finished = [
            jid for jid, j in _JOBS.items()
            if j["status"] in ("completed", "failed", "cancelled")
        ]
        while len(finished) > _MAX_FINISHED_JOBS:
            oldest = finished.pop(0)
            _JOBS.pop(oldest, None)
    return entry


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def get_job_files(job_id: str) -> Optional[List[Dict[str, Any]]]:
    job = get_job(job_id)
    if job is None:
        return None
    return job.get("relative_files")


def get_job_output_dir(job_id: str) -> Optional[Path]:
    job = get_job(job_id)
    if job is None:
        return None
    return job.get("output_dir")


def get_job_progress(job_id: str) -> Optional[ExportProgress]:
    job = get_job(job_id)
    if job is None:
        return None
    return ExportProgress(
        job_id=job["id"],
        status=job["status"],
        progress_percent=job["progress_percent"],
        message=job["message"],
        files_generated=job["files_generated"],
        total_files_expected=job["total_files_expected"],
        download_ready=job["download_ready"],
        download_path=job["download_path"],
        error=job["error"],
    )


def cancel_job(job_id: str) -> bool:
    job = get_job(job_id)
    if job is None:
        return False
    job["cancel_event"].set()
    job["status"] = "cancelled"
    job["message"] = "Cancelled by user"
    return True


def _update_job(
    job: Dict[str, Any],
    *,
    status: Optional[str] = None,
    message: Optional[str] = None,
    progress_percent: Optional[int] = None,
    files_generated: Optional[int] = None,
    total_files_expected: Optional[int] = None,
    download_ready: Optional[bool] = None,
    download_path: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    if status is not None:
        job["status"] = status
    if message is not None:
        job["message"] = message
    if progress_percent is not None:
        job["progress_percent"] = max(0, min(100, progress_percent))
    if files_generated is not None:
        job["files_generated"] = files_generated
    if total_files_expected is not None:
        job["total_files_expected"] = total_files_expected
    if download_ready is not None:
        job["download_ready"] = download_ready
    if download_path is not None:
        job["download_path"] = download_path
    if error is not None:
        job["error"] = error


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date(value: str) -> str:
    """Normalise a date string to YYYY-MM-DD."""
    raw = value.strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Cannot parse date: {value!r}")


def _format_date_indian(date_str: str) -> str:
    """Format YYYY-MM-DD to DD-MM-YYYY for display."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.strftime("%d-%m-%Y")
    except ValueError:
        return date_str


def _safe_filename(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in value)


def _month_key(date_str: str) -> str:
    """Return YYYY-MM from a YYYY-MM-DD string."""
    return date_str[:7]


def _year_key(date_str: str) -> str:
    """Return YYYY from a YYYY-MM-DD string."""
    return date_str[:4]


# ---------------------------------------------------------------------------
# Temporal CSV export
# ---------------------------------------------------------------------------

def _export_temporal_csv(
    hooks: OperationBackendHooks,
    request: ExportRequest,
    output_dir: Path,
    job: Dict[str, Any],
    progress_offset: int,
    progress_total: int,
) -> List[str]:
    """
    Export basin-mean time series CSV for each selected variable.
    Reuses the existing calculate_basin_mean path through hooks.query_data.
    """
    start_date = _parse_date(request.start_date)
    end_date = _parse_date(request.end_date)
    year_start, year_end = hooks.normalize_year_range(
        request.year_start, request.year_end
    )
    state = hooks.ensure_dataset_loaded(
        request.dataset, year_start=year_start, year_end=year_end
    )

    # Resolve subregion / AOI
    subregion = None
    if request.aoi_geojson:
        from main import _parse_aoi_geojson
        subregion = _parse_aoi_geojson(request.aoi_geojson)
    elif request.subregion_id:
        subregion = hooks.get_subregion(request.subregion_id)

    elev_min, elev_max = hooks.resolve_elevation_bounds(
        state, request.elev_min, request.elev_max
    )

    generated_files: List[str] = []
    n_vars = len(request.variables)
    csv_dir = output_dir / "temporal_csv"
    csv_dir.mkdir(parents=True, exist_ok=True)

    for var_idx, variable in enumerate(request.variables):
        if job["cancel_event"].is_set():
            break

        all_known = set(state.get("variables", [])).union(state.get("all_columns", []))
        if variable in all_known:
            var_name = variable
        else:
            var_name = hooks.validate_variable(state, variable)
        _update_job(
            job,
            message=f"Exporting temporal CSV: {var_name} ({var_idx + 1}/{n_vars})",
        )

        # Collect basin mean for date range
        from main import calculate_basin_mean, snapshot_dataset_state
        query_state = snapshot_dataset_state(state)
        data = calculate_basin_mean(
            query_state,
            start_date,
            end_date,
            elev_min,
            elev_max,
            var_name,
            subregion=subregion,
        )

        # Write CSV
        safe_var = _safe_filename(var_name)
        csv_path = csv_dir / f"{safe_var}_{start_date}_to_{end_date}.csv"
        with open(csv_path, "w", newline="", encoding="utf-8") as fh:
            # Metadata header
            fh.write(f"# Export: Temporal Basin Mean Time Series\n")
            fh.write(f"# Dataset: {state.get('id', 'unknown')} — {state.get('label', '')}\n")
            fh.write(f"# Variable: {var_name}\n")
            fh.write(f"# Date Range: {_format_date_indian(start_date)} to {_format_date_indian(end_date)}\n")
            fh.write(f"# Elevation Range: {elev_min}m to {elev_max}m\n")
            if subregion:
                fh.write(f"# ROI: {subregion.get('label', subregion.get('id', 'Custom'))}\n")
            fh.write(f"# Exported: {datetime.utcnow().isoformat()}Z\n")
            fh.write(f"# Generator: Himalayan Basin Analytics\n")
            fh.write("#\n")

            writer = csv.DictWriter(fh, fieldnames=["date", "date_display", "mean_value", "pixel_count"])
            writer.writeheader()
            for row in data:
                writer.writerow({
                    "date": row["date"],
                    "date_display": row.get("date_display", _format_date_indian(row["date"])),
                    "mean_value": row.get("mean_value", ""),
                    "pixel_count": row.get("pixel_count", ""),
                })

        generated_files.append(str(csv_path))
        pct = progress_offset + int((var_idx + 1) / max(n_vars, 1) * progress_total)
        _update_job(job, progress_percent=pct, files_generated=len(generated_files))
        logger.info("[export] Wrote temporal CSV: %s (%d rows)", csv_path.name, len(data))

    return generated_files


# ---------------------------------------------------------------------------
# Spatial map export
# ---------------------------------------------------------------------------

def _export_spatial_maps(
    hooks: OperationBackendHooks,
    request: ExportRequest,
    output_dir: Path,
    job: Dict[str, Any],
    progress_offset: int,
    progress_total: int,
) -> List[str]:
    """
    Export spatial raster maps (daily) and then optionally aggregate to
    monthly / yearly multi-band files.
    """
    start_date = _parse_date(request.start_date)
    end_date = _parse_date(request.end_date)
    year_start, year_end = hooks.normalize_year_range(
        request.year_start, request.year_end
    )
    state = hooks.ensure_dataset_loaded(
        request.dataset, year_start=year_start, year_end=year_end
    )

    subregion = None
    if request.aoi_geojson:
        from main import _parse_aoi_geojson
        subregion = _parse_aoi_geojson(request.aoi_geojson)
    elif request.subregion_id:
        subregion = hooks.get_subregion(request.subregion_id)

    elev_min, elev_max = hooks.resolve_elevation_bounds(
        state, request.elev_min, request.elev_max
    )

    # Determine dates in range
    date_index = state.get("date_index", {})
    dates_in_range = sorted(d for d in date_index if start_date <= d <= end_date)

    n_vars = len(request.variables)
    is_geotiff = request.spatial_format == "geotiff"
    aggregation = request.spatial_aggregation

    # Work out total work units for progress
    total_daily_tasks = len(dates_in_range) * n_vars
    generated_files: List[str] = []

    if is_geotiff:
        spatial_dir = output_dir / "spatial_geotiff"
    else:
        spatial_dir = output_dir / "spatial_csv"
    spatial_dir.mkdir(parents=True, exist_ok=True)

    from main import snapshot_dataset_state
    query_state = snapshot_dataset_state(state)

    # For geotiff aggregation, we collect daily data keyed by group
    # group_key -> [ (date, array_2d, transform, crs_wkt) ]
    daily_geotiff_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    task_counter = 0
    for var_idx, variable in enumerate(request.variables):
        if job["cancel_event"].is_set():
            break
        all_known = set(state.get("variables", [])).union(state.get("all_columns", []))
        if variable in all_known:
            var_name = variable
        else:
            var_name = hooks.validate_variable(state, variable)
        safe_var = _safe_filename(var_name)

        for date_idx, query_date in enumerate(dates_in_range):
            if job["cancel_event"].is_set():
                break

            task_counter += 1
            pct = progress_offset + int(task_counter / max(total_daily_tasks, 1) * progress_total)
            _update_job(
                job,
                message=f"Processing spatial {var_name}: {query_date} ({task_counter}/{total_daily_tasks})",
                progress_percent=pct,
            )

            # Query spatial data for this date + variable
            records = hooks.query_data(
                query_state,
                query_date,
                elev_min,
                elev_max,
                var_name,
                subregion,
            )

            if not records:
                continue

            if is_geotiff:
                _write_daily_geotiff_or_collect(
                    records=records,
                    variable=var_name,
                    query_date=query_date,
                    state=state,
                    subregion=subregion,
                    elev_min=elev_min,
                    elev_max=elev_max,
                    spatial_dir=spatial_dir,
                    aggregation=aggregation,
                    daily_groups=daily_geotiff_groups,
                    generated_files=generated_files,
                    safe_var=safe_var,
                )
            else:
                _write_spatial_csv(
                    records=records,
                    variable=var_name,
                    query_date=query_date,
                    state=state,
                    subregion=subregion,
                    elev_min=elev_min,
                    elev_max=elev_max,
                    spatial_dir=spatial_dir,
                    generated_files=generated_files,
                    safe_var=safe_var,
                )

            _update_job(job, files_generated=len(generated_files))

    # Aggregate if monthly/yearly geotiff
    if is_geotiff and aggregation in ("monthly", "yearly") and daily_geotiff_groups:
        _update_job(job, message=f"Aggregating {aggregation} GeoTIFF files...")
        for group_key, entries in daily_geotiff_groups.items():
            if job["cancel_event"].is_set():
                break
            out_path = _aggregate_geotiff(
                entries=entries,
                group_key=group_key,
                aggregation=aggregation,
                spatial_dir=spatial_dir,
            )
            if out_path:
                generated_files.append(str(out_path))
                _update_job(job, files_generated=len(generated_files))

    return generated_files


def _records_to_grid(records: List[Dict]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Convert [{lat, lon, value, ...}] records to sorted arrays."""
    lats = np.array([r["lat"] for r in records], dtype=np.float64)
    lons = np.array([r["lon"] for r in records], dtype=np.float64)
    values = np.array([r["value"] for r in records], dtype=np.float64)
    return lats, lons, values


def _infer_resolution(coords: np.ndarray) -> float:
    """Infer grid resolution from sorted unique coordinates."""
    unique = np.unique(coords)
    if len(unique) < 2:
        return 0.1  # fallback
    diffs = np.diff(unique)
    return float(np.min(diffs[diffs > 1e-9])) if np.any(diffs > 1e-9) else 0.1


def _build_raster_from_points(
    lats: np.ndarray,
    lons: np.ndarray,
    values: np.ndarray,
) -> Tuple[np.ndarray, Any, int, int]:
    """
    Build a 2D raster from scattered point data.
    Returns (2d_array, rasterio_transform, height, width).
    """
    import rasterio.transform  # type: ignore

    lat_res = _infer_resolution(lats)
    lon_res = _infer_resolution(lons)

    min_lat, max_lat = float(np.min(lats)), float(np.max(lats))
    min_lon, max_lon = float(np.min(lons)), float(np.max(lons))

    # Build grid
    nrows = max(1, int(np.round((max_lat - min_lat) / lat_res)) + 1)
    ncols = max(1, int(np.round((max_lon - min_lon) / lon_res)) + 1)

    # The rasterio convention: transform maps pixel (col, row) to (lon, lat)
    # with origin at upper-left (max_lat, min_lon)
    transform = rasterio.transform.from_bounds(
        min_lon - lon_res / 2,
        min_lat - lat_res / 2,
        max_lon + lon_res / 2,
        max_lat + lat_res / 2,
        ncols,
        nrows,
    )

    grid = np.full((nrows, ncols), np.nan, dtype=np.float64)

    # Map points to grid cells
    row_indices = np.clip(
        np.round((max_lat - lats) / lat_res).astype(int), 0, nrows - 1
    )
    col_indices = np.clip(
        np.round((lons - min_lon) / lon_res).astype(int), 0, ncols - 1
    )
    grid[row_indices, col_indices] = values

    return grid, transform, nrows, ncols


def _write_daily_geotiff_or_collect(
    *,
    records: List[Dict],
    variable: str,
    query_date: str,
    state: Dict[str, Any],
    subregion: Optional[Dict[str, Any]],
    elev_min: float,
    elev_max: float,
    spatial_dir: Path,
    aggregation: str,
    daily_groups: Dict[str, List[Dict[str, Any]]],
    generated_files: List[str],
    safe_var: str,
) -> None:
    """Write daily GeoTIFF or collect for aggregation."""
    import rasterio  # type: ignore

    lats, lons, values = _records_to_grid(records)
    if lats.size == 0:
        return

    grid, transform, nrows, ncols = _build_raster_from_points(lats, lons, values)

    metadata = {
        "VARIABLE": variable,
        "DATASET": state.get("id", "unknown"),
        "DATASET_LABEL": state.get("label", ""),
        "DATE": query_date,
        "ELEVATION_RANGE": f"{elev_min}-{elev_max}m",
        "CRS": "EPSG:4326",
        "ROI": subregion.get("label", subregion.get("id", "Custom")) if subregion else "Full Basin",
        "EXPORT_TIME": datetime.utcnow().isoformat() + "Z",
        "GENERATOR": "Himalayan Basin Analytics",
    }

    if aggregation == "daily":
        # Write individual daily file
        out_path = spatial_dir / f"{safe_var}_{query_date}.tif"
        profile = {
            "driver": "GTiff",
            "dtype": "float64",
            "count": 1,
            "height": nrows,
            "width": ncols,
            "crs": "EPSG:4326",
            "transform": transform,
            "compress": "deflate",
            "nodata": np.nan,
        }
        with rasterio.open(str(out_path), "w", **profile) as dst:
            dst.write(grid, 1)
            dst.update_tags(**metadata)
            dst.set_band_description(1, f"{variable} - {query_date}")
        generated_files.append(str(out_path))
        logger.info("[export] Wrote daily GeoTIFF: %s", out_path.name)
    else:
        # Collect for aggregation
        if aggregation == "monthly":
            group_key = f"{safe_var}_{_month_key(query_date)}"
        else:
            group_key = f"{safe_var}_{_year_key(query_date)}"
        daily_groups[group_key].append({
            "date": query_date,
            "grid": grid,
            "transform": transform,
            "nrows": nrows,
            "ncols": ncols,
            "variable": variable,
            "metadata_base": metadata,
        })


def _aggregate_geotiff(
    *,
    entries: List[Dict[str, Any]],
    group_key: str,
    aggregation: str,
    spatial_dir: Path,
) -> Optional[Path]:
    """
    Write a multi-band GeoTIFF where each band is one day's raster.
    Band descriptions store the date.
    """
    import rasterio  # type: ignore

    if not entries:
        return None

    # Sort by date
    entries.sort(key=lambda e: e["date"])

    # Use the grid shape/transform from the first entry.
    # All daily grids for the same variable should have the same extent
    # (since they come from the same ROI query).
    ref = entries[0]
    nrows = ref["nrows"]
    ncols = ref["ncols"]
    transform = ref["transform"]
    variable = ref["variable"]
    n_bands = len(entries)

    # Build aggregated metadata
    dates_list = [e["date"] for e in entries]
    agg_metadata = dict(ref["metadata_base"])
    agg_metadata["DATE"] = f"{dates_list[0]} to {dates_list[-1]}"
    agg_metadata["AGGREGATION"] = aggregation
    agg_metadata["BAND_COUNT"] = str(n_bands)
    agg_metadata["BAND_DATES"] = ",".join(dates_list)

    out_path = spatial_dir / f"{group_key}.tif"

    profile = {
        "driver": "GTiff",
        "dtype": "float64",
        "count": n_bands,
        "height": nrows,
        "width": ncols,
        "crs": "EPSG:4326",
        "transform": transform,
        "compress": "deflate",
        "nodata": np.nan,
    }

    with rasterio.open(str(out_path), "w", **profile) as dst:
        dst.update_tags(**agg_metadata)
        for band_idx, entry in enumerate(entries, start=1):
            grid = entry["grid"]
            # Resize if needed (in case of minor grid size differences)
            if grid.shape != (nrows, ncols):
                padded = np.full((nrows, ncols), np.nan, dtype=np.float64)
                h = min(grid.shape[0], nrows)
                w = min(grid.shape[1], ncols)
                padded[:h, :w] = grid[:h, :w]
                grid = padded
            dst.write(grid, band_idx)
            dst.set_band_description(band_idx, f"{variable} - {entry['date']}")

    logger.info(
        "[export] Wrote %s GeoTIFF: %s (%d bands)",
        aggregation, out_path.name, n_bands,
    )
    return out_path


def _write_spatial_csv(
    *,
    records: List[Dict],
    variable: str,
    query_date: str,
    state: Dict[str, Any],
    subregion: Optional[Dict[str, Any]],
    elev_min: float,
    elev_max: float,
    spatial_dir: Path,
    generated_files: List[str],
    safe_var: str,
) -> None:
    """Write a spatial CSV for one date + variable."""
    out_path = spatial_dir / f"{safe_var}_{query_date}.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        fh.write(f"# Export: Spatial Raster Data\n")
        fh.write(f"# Dataset: {state.get('id', 'unknown')} — {state.get('label', '')}\n")
        fh.write(f"# Variable: {variable}\n")
        fh.write(f"# Date: {_format_date_indian(query_date)}\n")
        fh.write(f"# Elevation Range: {elev_min}m to {elev_max}m\n")
        fh.write(f"# CRS: EPSG:4326\n")
        if subregion:
            fh.write(f"# ROI: {subregion.get('label', subregion.get('id', 'Custom'))}\n")
        fh.write(f"# Exported: {datetime.utcnow().isoformat()}Z\n")
        fh.write("#\n")

        writer = csv.DictWriter(
            fh, fieldnames=["latitude", "longitude", "elevation_m", variable]
        )
        writer.writeheader()
        for rec in records:
            writer.writerow({
                "latitude": rec.get("lat", ""),
                "longitude": rec.get("lon", ""),
                "elevation_m": rec.get("elev", ""),
                variable: rec.get("value", ""),
            })

    generated_files.append(str(out_path))
    logger.info("[export] Wrote spatial CSV: %s (%d rows)", out_path.name, len(records))


# ---------------------------------------------------------------------------
# ZIP packaging
# ---------------------------------------------------------------------------

def _package_zip(output_dir: Path, workspace_root: Path) -> str:
    """
    Package the entire output_dir into a single .zip and return its path.
    """
    zip_name = f"export_{output_dir.name}.zip"
    zip_path = workspace_root / zip_name
    with zipfile.ZipFile(str(zip_path), "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(output_dir.rglob("*")):
            if file_path.is_file():
                arcname = file_path.relative_to(output_dir)
                zf.write(str(file_path), str(arcname))
    return str(zip_path)


# ---------------------------------------------------------------------------
# Main export orchestrator
# ---------------------------------------------------------------------------

def _estimate_total_files(request: ExportRequest, date_count: int) -> int:
    total = 0
    n_vars = len(request.variables)
    if request.export_temporal_csv:
        total += n_vars
    if request.export_spatial_maps:
        if request.spatial_aggregation == "daily":
            total += date_count * n_vars
        elif request.spatial_aggregation == "monthly":
            # Rough estimate: ~12 months per year
            total += n_vars * max(1, date_count // 30)
        else:
            total += n_vars * max(1, date_count // 365)
    return max(1, total)


def run_export(
    request: ExportRequest,
    hooks: OperationBackendHooks,
    workspace_root: Path,
) -> str:
    """
    Start a background export job. Returns the job_id immediately.
    The actual work runs in a daemon thread.
    """
    job_id = f"exp_{uuid.uuid4().hex[:12]}"
    job = _register_job(job_id, request)

    def _worker():
        try:
            _update_job(job, status="running", message="Starting export...")

            # Parse and validate upfront
            start_date = _parse_date(request.start_date)
            end_date = _parse_date(request.end_date)
            year_start, year_end = hooks.normalize_year_range(
                request.year_start, request.year_end
            )
            state = hooks.ensure_dataset_loaded(
                request.dataset, year_start=year_start, year_end=year_end
            )
            date_index = state.get("date_index", {})
            dates_in_range = sorted(d for d in date_index if start_date <= d <= end_date)

            total_est = _estimate_total_files(request, len(dates_in_range))
            _update_job(job, total_files_expected=total_est)

            # Create output directory
            output_dir = workspace_root / job_id
            output_dir.mkdir(parents=True, exist_ok=True)

            # Write export metadata JSON
            meta_path = output_dir / "export_metadata.json"
            export_meta = {
                "job_id": job_id,
                "dataset": state.get("id"),
                "dataset_label": state.get("label"),
                "variables": request.variables,
                "start_date": start_date,
                "end_date": end_date,
                "elevation_range": [request.elev_min, request.elev_max],
                "subregion_id": request.subregion_id,
                "has_aoi": bool(request.aoi_geojson),
                "export_temporal_csv": request.export_temporal_csv,
                "export_spatial_maps": request.export_spatial_maps,
                "spatial_format": request.spatial_format,
                "spatial_aggregation": request.spatial_aggregation,
                "dates_in_range": len(dates_in_range),
                "exported_at": datetime.utcnow().isoformat() + "Z",
            }
            with open(meta_path, "w", encoding="utf-8") as fh:
                json.dump(export_meta, fh, indent=2)

            all_files: List[str] = [str(meta_path)]

            # Determine progress allocation
            temporal_pct = 30 if request.export_temporal_csv else 0
            spatial_pct = 60 if request.export_spatial_maps else 0
            zip_pct = 10

            # 1) Temporal CSV export
            if request.export_temporal_csv and not job["cancel_event"].is_set():
                csv_files = _export_temporal_csv(
                    hooks, request, output_dir, job,
                    progress_offset=0,
                    progress_total=temporal_pct,
                )
                all_files.extend(csv_files)

            # 2) Spatial map export
            if request.export_spatial_maps and not job["cancel_event"].is_set():
                map_files = _export_spatial_maps(
                    hooks, request, output_dir, job,
                    progress_offset=temporal_pct,
                    progress_total=spatial_pct,
                )
                all_files.extend(map_files)

            if job["cancel_event"].is_set():
                _update_job(job, status="cancelled", message="Export cancelled")
                # Clean up
                shutil.rmtree(str(output_dir), ignore_errors=True)
                return

            # Record output directory and relative files for direct file access
            job["output_dir"] = output_dir
            relative_files = []
            for f in sorted(output_dir.rglob("*")):
                if f.is_file():
                    relative_files.append({
                        "path": str(f.relative_to(output_dir)).replace("\\", "/"),
                        "size_bytes": f.stat().st_size,
                    })
            job["relative_files"] = relative_files

            # Copy to server destination_folder if requested
            if request.destination_folder:
                try:
                    dest_p = Path(request.destination_folder)
                    dest_p.mkdir(parents=True, exist_ok=True)
                    for f in output_dir.rglob("*"):
                        if f.is_file():
                            rel = f.relative_to(output_dir)
                            target = dest_p / rel
                            target.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(str(f), str(target))
                    logger.info("[export] Copied %d files to destination_folder: %s", len(all_files), dest_p)
                except Exception as copy_err:
                    logger.warning("[export] Could not copy to destination_folder %s: %s", request.destination_folder, copy_err)

            # 3) Package ZIP
            _update_job(
                job,
                message="Packaging ZIP file...",
                progress_percent=temporal_pct + spatial_pct,
            )
            zip_path = _package_zip(output_dir, workspace_root)

            _update_job(
                job,
                status="completed",
                progress_percent=100,
                message=f"Export complete — {len(all_files)} files",
                files_generated=len(all_files),
                download_ready=True,
                download_path=zip_path,
            )
            logger.info("[export] Job %s completed: %d files, zip=%s", job_id, len(all_files), zip_path)

        except Exception as exc:
            logger.exception("[export] Job %s failed", job_id)
            _update_job(
                job,
                status="failed",
                message=f"Export failed: {exc}",
                error=str(exc),
            )

    thread = threading.Thread(target=_worker, daemon=True, name=f"export-{job_id}")
    job["thread"] = thread
    thread.start()
    return job_id
