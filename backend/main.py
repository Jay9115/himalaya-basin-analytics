"""
FastAPI backend for local geospatial visualization.
Supports multiple datasets (ERA5 and CMIP6) with lazy indexing.
"""
from datetime import datetime
import mimetypes
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import logging
import re
import sys

import pandas as pd
import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Temperature Data Visualization API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for HF Spaces deployment
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

def get_runtime_base_dir() -> Path:
    """Resolve app root for source mode and frozen executable mode."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


WEBAPP_DIR = get_runtime_base_dir()
MAP_ASSETS_DIR = WEBAPP_DIR / "Map_handle"
DATABASE_DIR = WEBAPP_DIR / "Database"
FRONTEND_DIST_CANDIDATES = [
    WEBAPP_DIR / "frontend_dist",
    WEBAPP_DIR / "frontend" / "dist",
    WEBAPP_DIR / "dist",
]
FRONTEND_DIST_DIR = next((p for p in FRONTEND_DIST_CANDIDATES if p.exists()), FRONTEND_DIST_CANDIDATES[0])

DATASET_CONFIGS: Dict[str, Dict] = {
    "era5": {
        "label": "ERA5 Full Shape",
        "paths": [
            DATABASE_DIR / "Full_Shape_ERA5",
        ],
    },
    "cmip6": {
        "label": "CMIP6 Full Shape",
        "paths": [
            DATABASE_DIR / "Full_shape_CMIP6",
        ],
    },
}

DEFAULT_DATASET_ID = "era5"
EXCLUDE_COLUMNS = {"system:index", ".geo"}
DATE_CANDIDATES = ["date", "Date", "DATE"]
LAT_CANDIDATES = ["latitude", "lat", "Latitude", "Lat"]
LON_CANDIDATES = ["longitude", "lon", "Longitude", "Lon"]
ELEV_CANDIDATES = ["elevation_m", "elev", "elevation", "Elevation_m"]
FIXED_ELEV_MIN = 500.0
FIXED_ELEV_MAX = 9000.0
YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")

# Keeps metadata + index cache for each dataset id.
DATASET_STATE: Dict[str, Dict] = {}


def setup_frontend_static_assets() -> None:
    assets_dir = FRONTEND_DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")
        logger.info(f"Serving frontend assets from {assets_dir}")
    else:
        logger.info("Frontend dist assets folder not found. API-only mode enabled.")


setup_frontend_static_assets()


def _resolve_map_asset(asset_path: str) -> Path:
    if not MAP_ASSETS_DIR.exists():
        raise HTTPException(status_code=404, detail=f"Map assets folder not found: {MAP_ASSETS_DIR}")

    safe_relative = asset_path.replace("\\", "/").lstrip("/")
    resolved = (MAP_ASSETS_DIR / safe_relative).resolve()
    map_root = MAP_ASSETS_DIR.resolve()

    if map_root not in resolved.parents and resolved != map_root:
        raise HTTPException(status_code=400, detail="Invalid map asset path")
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"Map asset not found: {asset_path}")

    return resolved


def _parse_range_header(range_header: str, file_size: int) -> Tuple[int, int]:
    if not range_header.startswith("bytes="):
        raise HTTPException(status_code=416, detail="Invalid range unit")

    parts = range_header.replace("bytes=", "", 1).split(",", 1)[0].strip()
    if "-" not in parts:
        raise HTTPException(status_code=416, detail="Invalid range format")

    start_raw, end_raw = parts.split("-", 1)
    if start_raw == "":
        # bytes=-N (suffix)
        try:
            suffix_length = int(end_raw)
        except ValueError as exc:
            raise HTTPException(status_code=416, detail="Invalid range suffix") from exc
        if suffix_length <= 0:
            raise HTTPException(status_code=416, detail="Invalid range suffix")
        start = max(file_size - suffix_length, 0)
        end = file_size - 1
    else:
        try:
            start = int(start_raw)
        except ValueError as exc:
            raise HTTPException(status_code=416, detail="Invalid range start") from exc
        if end_raw == "":
            end = file_size - 1
        else:
            try:
                end = int(end_raw)
            except ValueError as exc:
                raise HTTPException(status_code=416, detail="Invalid range end") from exc

    if start < 0 or end < 0 or start >= file_size or end >= file_size or start > end:
        raise HTTPException(status_code=416, detail="Range not satisfiable")

    return start, end


def _iter_file_chunk(file_path: Path, start: int, end: int):
    chunk_size = 1024 * 1024
    remaining = end - start + 1
    with file_path.open("rb") as file_obj:
        file_obj.seek(start)
        while remaining > 0:
            data = file_obj.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _media_type_for_asset(asset_path: Path) -> str:
    if asset_path.suffix.lower() == ".pmtiles":
        return "application/vnd.pmtiles"
    guessed, _ = mimetypes.guess_type(str(asset_path))
    return guessed or "application/octet-stream"


def build_range_not_satisfiable(file_size: int) -> Response:
    return Response(
        status_code=416,
        headers={"Content-Range": f"bytes */{file_size}", "Accept-Ranges": "bytes"},
    )


def serve_map_asset(asset_path: str, request: Request, head_only: bool = False):
    file_path = _resolve_map_asset(asset_path)
    file_size = file_path.stat().st_size
    media_type = _media_type_for_asset(file_path)
    range_header = request.headers.get("range")
    suffix = file_path.suffix.lower()
    cache_control = "public, max-age=3600"
    # Keep GeoJSON fresh to avoid stale basin boundary overlays after shape updates.
    if suffix in {".geojson", ".json"}:
        cache_control = "no-cache, max-age=0"

    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": cache_control,
    }

    if not range_header:
        if head_only:
            headers = {**base_headers, "Content-Length": str(file_size)}
            return Response(status_code=200, media_type=media_type, headers=headers)
        return FileResponse(path=str(file_path), media_type=media_type, headers=base_headers)

    try:
        start, end = _parse_range_header(range_header, file_size)
    except HTTPException:
        return build_range_not_satisfiable(file_size)

    content_length = end - start + 1
    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    }

    if head_only:
        return Response(status_code=206, media_type=media_type, headers=headers)

    return StreamingResponse(
        _iter_file_chunk(file_path, start, end),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


def resolve_dataset_path(paths: List[Path]) -> Path:
    """Prefer an existing path that already has parquet, else first existing path."""
    for path in paths:
        if path.exists() and list(path.glob("*.parquet")):
            return path
    for path in paths:
        if path.exists():
            return path
    return paths[0]


def init_dataset_state() -> None:
    DATASET_STATE.clear()
    for dataset_id, config in DATASET_CONFIGS.items():
        path = resolve_dataset_path(config["paths"])
        DATASET_STATE[dataset_id] = {
            "id": dataset_id,
            "label": config["label"],
            "path": path,
            "loaded": False,
            "active_index_key": None,
            "active_year_start": None,
            "active_year_end": None,
            "index_cache": {},
            "date_index": {},
            "variables": [],
            "default_variable": None,
            "date_col": None,
            "lat_col": None,
            "lon_col": None,
            "elev_col": None,
            "all_columns": [],
            "elevation_range": None,
        }


def count_files(path: Path, pattern: str) -> int:
    if not path.exists():
        return 0
    return len(list(path.glob(pattern)))


def get_datasets_summary() -> List[Dict]:
    summary = []
    for dataset_id, state in DATASET_STATE.items():
        path = state["path"]
        parquet_count = count_files(path, "*.parquet")
        csv_count = count_files(path, "*.csv")
        summary.append(
            {
                "id": dataset_id,
                "label": state["label"],
                "path": str(path),
                "parquet_files": parquet_count,
                "csv_files": csv_count,
                "ready": parquet_count > 0,
            }
        )
    return summary


def ensure_dataset(dataset: Optional[str]) -> Dict:
    dataset_id = dataset or DEFAULT_DATASET_ID
    state = DATASET_STATE.get(dataset_id)
    if not state:
        raise HTTPException(status_code=400, detail=f"Invalid dataset '{dataset_id}'")
    return state


def pick_column(columns: List[str], candidates: List[str], field_name: str) -> str:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    raise HTTPException(status_code=500, detail=f"Could not detect {field_name} column in dataset schema")


def choose_default_variable(variables: List[str]) -> Optional[str]:
    preferred = ["temperature_C", "temp_mean_C", "temp_C", "temperature"]
    for name in preferred:
        if name in variables:
            return name
    if variables:
        return variables[0]
    return None


def normalize_year_range(year_start: Optional[int], year_end: Optional[int]) -> Tuple[Optional[int], Optional[int]]:
    if year_start is None and year_end is None:
        return None, None

    if year_start is not None and (year_start < 1800 or year_start > 2200):
        raise HTTPException(status_code=400, detail="year_start must be between 1800 and 2200")
    if year_end is not None and (year_end < 1800 or year_end > 2200):
        raise HTTPException(status_code=400, detail="year_end must be between 1800 and 2200")
    if year_start is not None and year_end is not None and year_start > year_end:
        raise HTTPException(status_code=400, detail="year_start cannot be greater than year_end")

    return year_start, year_end


def build_index_cache_key(year_start: Optional[int], year_end: Optional[int]) -> str:
    start_key = "*" if year_start is None else str(year_start)
    end_key = "*" if year_end is None else str(year_end)
    return f"{start_key}:{end_key}"


def extract_years_from_filename(file_path: Path) -> List[int]:
    years = {int(match) for match in YEAR_PATTERN.findall(file_path.stem)}
    return sorted(years)


def select_files_for_year_range(
    parquet_files: List[Path],
    year_start: Optional[int],
    year_end: Optional[int],
) -> List[Path]:
    if year_start is None and year_end is None:
        return parquet_files

    selected: List[Path] = []
    for file_path in parquet_files:
        years = extract_years_from_filename(file_path)
        if not years:
            selected.append(file_path)
            continue
        min_year = min(years)
        max_year = max(years)
        if year_start is not None and max_year < year_start:
            continue
        if year_end is not None and min_year > year_end:
            continue
        selected.append(file_path)

    return selected


def _parse_non_empty_dates(values: pd.Series, context: str) -> pd.Series:
    """Parse non-empty date values and fail loudly on invalid formats."""
    try:
        try:
            return pd.to_datetime(values, errors="raise", format="mixed")
        except TypeError:
            # pandas < 2.0 does not support format="mixed"
            return pd.to_datetime(values, errors="raise")
    except Exception as exc:
        sample_values = values.astype(str).head(3).tolist()
        raise ValueError(
            f"Invalid date values in {context}. Sample values: {sample_values}"
        ) from exc


def parse_datetime_series(series: pd.Series, context: str) -> pd.Series:
    """Strict datetime parsing that never silently coerces invalid dates."""
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="raise")

    series_as_str = series.astype("string")
    missing_mask = series_as_str.isna() | (series_as_str.str.strip() == "")
    parsed = pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")

    non_empty_values = series_as_str[~missing_mask]
    if not non_empty_values.empty:
        parsed_non_empty = _parse_non_empty_dates(non_empty_values, context)
        parsed.loc[~missing_mask] = parsed_non_empty.values
    return parsed


def compute_dataset_elevation_range(state: Dict) -> Tuple[float, float]:
    """Compute elevation bounds across all parquet files in the dataset."""
    cached = state.get("elevation_range")
    if cached:
        return cached["min"], cached["max"]

    parquet_files = sorted(state["path"].glob("*.parquet"))
    if not parquet_files:
        raise HTTPException(status_code=404, detail=f"No data files found for dataset '{state['id']}'")

    elev_col = state["elev_col"]
    if not elev_col:
        raise HTTPException(status_code=500, detail=f"Elevation column not configured for dataset '{state['id']}'")

    min_elevation: Optional[float] = None
    max_elevation: Optional[float] = None
    for file_path in parquet_files:
        try:
            elev_series = pd.read_parquet(file_path, columns=[elev_col])[elev_col]
            numeric_elev = pd.to_numeric(elev_series, errors="coerce")
            invalid_mask = elev_series.notna() & numeric_elev.isna()
            if invalid_mask.any():
                samples = elev_series[invalid_mask].astype(str).head(3).tolist()
                raise ValueError(f"invalid elevation values {samples}")

            numeric_elev = numeric_elev.dropna()
            if numeric_elev.empty:
                continue

            file_min = float(numeric_elev.min())
            file_max = float(numeric_elev.max())
            min_elevation = file_min if min_elevation is None else min(min_elevation, file_min)
            max_elevation = file_max if max_elevation is None else max(max_elevation, file_max)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed reading elevation values from {file_path.name}: {exc}",
            ) from exc

    if min_elevation is None or max_elevation is None:
        raise HTTPException(
            status_code=500,
            detail=f"No valid elevation values found for dataset '{state['id']}'",
        )

    state["elevation_range"] = {"min": min_elevation, "max": max_elevation}
    return min_elevation, max_elevation


def resolve_elevation_bounds(state: Dict, elev_min: Optional[float], elev_max: Optional[float]) -> Tuple[float, float]:
    """Use fixed elevation bounds and clamp custom values to those bounds."""
    if elev_min is None:
        elev_min = FIXED_ELEV_MIN
    if elev_max is None:
        elev_max = FIXED_ELEV_MAX

    elev_min = max(FIXED_ELEV_MIN, min(float(elev_min), FIXED_ELEV_MAX))
    elev_max = max(FIXED_ELEV_MIN, min(float(elev_max), FIXED_ELEV_MAX))

    if elev_min > elev_max:
        raise HTTPException(status_code=400, detail="elev_min cannot be greater than elev_max")

    return elev_min, elev_max


def load_schema(state: Dict, parquet_files: List[Path]) -> None:
    if not parquet_files:
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        return

    try:
        columns = list(pq.ParquetFile(parquet_files[0]).schema.names)
    except Exception:
        sample_df = pd.read_parquet(parquet_files[0])
        columns = list(sample_df.columns)

    date_col = pick_column(columns, DATE_CANDIDATES, "date")
    lat_col = pick_column(columns, LAT_CANDIDATES, "latitude")
    lon_col = pick_column(columns, LON_CANDIDATES, "longitude")
    elev_col = pick_column(columns, ELEV_CANDIDATES, "elevation")

    base_cols = {date_col, lat_col, lon_col, elev_col}
    variables = sorted([c for c in columns if c not in EXCLUDE_COLUMNS and c not in base_cols])

    state["date_col"] = date_col
    state["lat_col"] = lat_col
    state["lon_col"] = lon_col
    state["elev_col"] = elev_col
    state["variables"] = variables
    state["default_variable"] = choose_default_variable(variables)
    state["all_columns"] = [date_col, lat_col, lon_col, elev_col] + variables


def load_dataset_index(
    state: Dict,
    force_reload: bool = False,
    year_start: Optional[int] = None,
    year_end: Optional[int] = None,
) -> None:
    cache_key = build_index_cache_key(year_start, year_end)
    if state["loaded"] and not force_reload and state.get("active_index_key") == cache_key:
        return

    if force_reload:
        state["index_cache"] = {}

    cached = state["index_cache"].get(cache_key)
    if cached and not force_reload:
        state["date_index"] = cached["date_index"]
        state["loaded"] = True
        state["active_index_key"] = cache_key
        state["active_year_start"] = year_start
        state["active_year_end"] = year_end
        return

    path = state["path"]
    parquet_files = sorted(path.glob("*.parquet")) if path.exists() else []
    if not parquet_files:
        state["loaded"] = False
        state["active_index_key"] = None
        state["active_year_start"] = None
        state["active_year_end"] = None
        state["date_index"] = {}
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        state["elevation_range"] = None
        logger.warning(f"No parquet files found for dataset '{state['id']}' in {path}")
        return

    if force_reload or not state["all_columns"]:
        load_schema(state, parquet_files)
    date_col = state["date_col"]

    candidate_files = select_files_for_year_range(parquet_files, year_start, year_end)
    year_tag = f"{year_start or '*'}-{year_end or '*'}"
    logger.info(
        f"Loading index for dataset '{state['id']}' from {path} "
        f"(years {year_tag}, files {len(candidate_files)}/{len(parquet_files)})"
    )

    date_index: Dict[str, List[str]] = {}
    indexing_errors: List[str] = []
    for file_path in candidate_files:
        try:
            df = pd.read_parquet(file_path, columns=[date_col])
            parsed_dates = parse_datetime_series(df[date_col], f"{file_path.name}:{date_col}")

            valid_dates = parsed_dates.dropna()
            if year_start is not None:
                valid_dates = valid_dates[valid_dates.dt.year >= year_start]
            if year_end is not None:
                valid_dates = valid_dates[valid_dates.dt.year <= year_end]

            dates = valid_dates.dt.date.unique()
            for date_item in dates:
                date_str = date_item.strftime("%Y-%m-%d")
                date_index.setdefault(date_str, []).append(str(file_path))
            logger.info(f"[{state['id']}] Indexed {file_path.name}: {len(dates)} dates")
        except Exception as exc:
            message = f"[{state['id']}] Failed indexing {file_path.name}: {exc}"
            logger.error(message)
            indexing_errors.append(message)

    if indexing_errors:
        state["loaded"] = False
        state["active_index_key"] = None
        state["active_year_start"] = None
        state["active_year_end"] = None
        state["date_index"] = {}
        state["elevation_range"] = None
        raise HTTPException(
            status_code=500,
            detail=(
                f"Date parsing/indexing failed for {len(indexing_errors)} file(s) in dataset '{state['id']}'. "
                f"First error: {indexing_errors[0]}"
            ),
        )

    state["date_index"] = date_index
    state["loaded"] = True
    state["active_index_key"] = cache_key
    state["active_year_start"] = year_start
    state["active_year_end"] = year_end
    state["elevation_range"] = None
    state["index_cache"][cache_key] = {"date_index": date_index}
    while len(state["index_cache"]) > 6:
        oldest = next(iter(state["index_cache"]))
        del state["index_cache"][oldest]

    logger.info(f"[{state['id']}] Total indexed dates ({year_tag}): {len(date_index)}")


def ensure_dataset_loaded(
    dataset: Optional[str],
    year_start: Optional[int] = None,
    year_end: Optional[int] = None,
) -> Dict:
    state = ensure_dataset(dataset)
    load_dataset_index(state, year_start=year_start, year_end=year_end)
    if not state["loaded"]:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No parquet files found for dataset '{state['id']}'. "
                f"Convert CSV files first in {state['path']}."
            ),
        )
    return state


def read_parquet_subset(
    file_path: str,
    columns_key: Tuple[str, ...],
    date_col: str,
    filters: Optional[List[Tuple[str, str, object]]] = None,
) -> pd.DataFrame:
    """
    Read only required columns (and filters when possible) from parquet.
    Falls back to pandas read_parquet if filtered Arrow read is not supported.
    """
    columns = list(dict.fromkeys(columns_key))
    try:
        table = pq.read_table(file_path, columns=columns, filters=filters)
        df = table.to_pandas()
    except Exception as exc:
        logger.debug(
            "Filtered parquet read fallback for %s due to: %s",
            Path(file_path).name,
            exc,
        )
        df = pd.read_parquet(file_path, columns=columns)

    if date_col in df.columns:
        parsed_dates = parse_datetime_series(df[date_col], f"{Path(file_path).name}:{date_col}")
        df[date_col] = parsed_dates.dt.normalize()
    return df


def validate_variable(state: Dict, variable: Optional[str]) -> str:
    var_name = variable or state["default_variable"]
    if not var_name:
        raise HTTPException(status_code=404, detail=f"No variables available in dataset '{state['id']}'")
    if var_name not in state["variables"]:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid variable '{var_name}'. Choose from: {state['variables']}",
        )
    return var_name


def query_data(state: Dict, query_date: str, elev_min: float, elev_max: float, variable: str) -> List[Dict]:
    if query_date not in state["date_index"]:
        return []

    date_col = state["date_col"]
    lat_col = state["lat_col"]
    lon_col = state["lon_col"]
    elev_col = state["elev_col"]
    qdate = pd.Timestamp(query_date)

    results: List[Dict] = []
    for file_path in state["date_index"][query_date]:
        try:
            columns_key = (date_col, lat_col, lon_col, elev_col, variable)
            filters = [
                (date_col, "==", qdate.to_pydatetime()),
                (elev_col, ">=", float(elev_min)),
                (elev_col, "<=", float(elev_max)),
            ]
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
            if df.empty:
                continue
            mask = (
                (df[date_col] == qdate)
                & (df[elev_col] >= elev_min)
                & (df[elev_col] <= elev_max)
            )
            if not mask.any():
                continue

            sliced = df.loc[mask, [lat_col, lon_col, elev_col, variable]].rename(
                columns={lat_col: "lat", lon_col: "lon", elev_col: "elev", variable: "value"}
            )
            results.extend(sliced.to_dict("records"))
        except Exception as exc:
            logger.error(f"[{state['id']}] Error querying {file_path}: {exc}")

    return results


def calculate_basin_mean(
    state: Dict,
    start_date: str,
    end_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
) -> List[Dict]:
    dates = sorted([d for d in state["date_index"].keys() if start_date <= d <= end_date])
    if not dates:
        return []

    date_col = state["date_col"]
    elev_col = state["elev_col"]
    files = sorted(set(f for d in dates for f in state["date_index"][d]))
    start_ts = pd.Timestamp(start_date)
    end_ts = pd.Timestamp(end_date)

    results: List[Dict] = []
    for file_path in files:
        try:
            columns_key = (date_col, elev_col, variable)
            filters = [
                (date_col, ">=", start_ts.to_pydatetime()),
                (date_col, "<=", end_ts.to_pydatetime()),
                (elev_col, ">=", float(elev_min)),
                (elev_col, "<=", float(elev_max)),
            ]
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
            if df.empty:
                continue
            mask = (
                (df[date_col] >= start_ts)
                & (df[date_col] <= end_ts)
                & (df[elev_col] >= elev_min)
                & (df[elev_col] <= elev_max)
            )
            if not mask.any():
                continue

            grouped = (
                df.loc[mask, [date_col, variable]]
                .groupby(date_col, as_index=False)
                .agg(mean_value=(variable, "mean"), pixel_count=(variable, "count"))
            )
            grouped[date_col] = grouped[date_col].dt.strftime("%Y-%m-%d")

            for row in grouped.itertuples(index=False):
                results.append(
                    {
                        "date": getattr(row, date_col),
                        "mean_value": float(row.mean_value),
                        "pixel_count": int(row.pixel_count),
                    }
                )
        except Exception as exc:
            logger.error(f"[{state['id']}] Error in basin mean for {file_path}: {exc}")

    results.sort(key=lambda row: row["date"])
    return results


def calculate_region_mean(
    state: Dict,
    year: int,
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    elev_min: float,
    elev_max: float,
    variable: str,
) -> List[Dict]:
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"
    dates = sorted([d for d in state["date_index"].keys() if start_date <= d <= end_date])
    if not dates:
        return []

    date_col = state["date_col"]
    lat_col = state["lat_col"]
    lon_col = state["lon_col"]
    elev_col = state["elev_col"]
    files = sorted(set(f for d in dates for f in state["date_index"][d]))
    start_ts = pd.Timestamp(start_date)
    end_ts = pd.Timestamp(end_date)

    results: List[Dict] = []
    for file_path in files:
        try:
            columns_key = (date_col, lat_col, lon_col, elev_col, variable)
            filters = [
                (date_col, ">=", start_ts.to_pydatetime()),
                (date_col, "<=", end_ts.to_pydatetime()),
                (lat_col, ">=", float(min_lat)),
                (lat_col, "<=", float(max_lat)),
                (lon_col, ">=", float(min_lon)),
                (lon_col, "<=", float(max_lon)),
                (elev_col, ">=", float(elev_min)),
                (elev_col, "<=", float(elev_max)),
            ]
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
            if df.empty:
                continue
            mask = (
                (df[date_col] >= start_ts)
                & (df[date_col] <= end_ts)
                & (df[lat_col] >= min_lat)
                & (df[lat_col] <= max_lat)
                & (df[lon_col] >= min_lon)
                & (df[lon_col] <= max_lon)
                & (df[elev_col] >= elev_min)
                & (df[elev_col] <= elev_max)
            )
            if not mask.any():
                continue

            grouped = (
                df.loc[mask, [date_col, variable]]
                .groupby(date_col, as_index=False)
                .agg(mean_value=(variable, "mean"), pixel_count=(variable, "count"))
            )
            grouped[date_col] = grouped[date_col].dt.strftime("%Y-%m-%d")

            for row in grouped.itertuples(index=False):
                results.append(
                    {
                        "date": getattr(row, date_col),
                        "mean_value": float(row.mean_value),
                        "pixel_count": int(row.pixel_count),
                    }
                )
        except Exception as exc:
            logger.error(f"[{state['id']}] Error in region mean for {file_path}: {exc}")

    results.sort(key=lambda row: row["date"])
    return results


@app.on_event("startup")
async def startup_event() -> None:
    init_dataset_state()
    logger.info("Dataset state initialized")


@app.get("/")
async def root():
    index_path = FRONTEND_DIST_DIR / "index.html"
    if index_path.exists():
        return FileResponse(path=str(index_path), media_type="text/html")
    return {
        "status": "online",
        "message": "Temperature Visualization API",
        "default_dataset": DEFAULT_DATASET_ID,
        "datasets": get_datasets_summary(),
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "api": True,
        "frontend_dist": str(FRONTEND_DIST_DIR),
        "frontend_index_exists": (FRONTEND_DIST_DIR / "index.html").exists(),
    }


@app.get("/map-assets/{asset_path:path}")
async def get_map_asset(asset_path: str, request: Request):
    return serve_map_asset(asset_path, request, head_only=False)


@app.head("/map-assets/{asset_path:path}")
async def head_map_asset(asset_path: str, request: Request):
    return serve_map_asset(asset_path, request, head_only=True)


# Backward-compatible alias if any frontend still points to /india_admin.pmtiles
@app.get("/india_admin.pmtiles")
async def get_india_admin_pmtiles(request: Request):
    return serve_map_asset("india_admin.pmtiles", request, head_only=False)


@app.head("/india_admin.pmtiles")
async def head_india_admin_pmtiles(request: Request):
    return serve_map_asset("india_admin.pmtiles", request, head_only=True)


@app.get("/datasets")
async def get_datasets():
    return JSONResponse(
        content={
            "default_dataset": DEFAULT_DATASET_ID,
            "datasets": get_datasets_summary(),
        }
    )


@app.get("/years")
async def get_available_years(dataset: Optional[str] = Query(None, description="Dataset id")):
    state = ensure_dataset(dataset)
    parquet_files = sorted(state["path"].glob("*.parquet")) if state["path"].exists() else []
    if not parquet_files:
        return JSONResponse(
            content={
                "dataset": state["id"],
                "dataset_label": state["label"],
                "years": [],
                "min_year": None,
                "max_year": None,
            }
        )

    years: set[int] = set()
    for file_path in parquet_files:
        years.update(extract_years_from_filename(file_path))

    if not years:
        loaded_state = ensure_dataset_loaded(dataset)
        years = {int(date_str[:4]) for date_str in loaded_state["date_index"].keys()}

    years_list = sorted(years)
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "years": years_list,
            "min_year": years_list[0] if years_list else None,
            "max_year": years_list[-1] if years_list else None,
        }
    )


@app.get("/dates")
async def get_available_dates(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    dates = sorted(state["date_index"].keys())
    if not dates:
        return JSONResponse(
            content={
                "dates": [],
                "min_date": None,
                "max_date": None,
                "total": 0,
                "dataset": state["id"],
                "year_start": year_start,
                "year_end": year_end,
            }
        )

    return JSONResponse(
        content={
            "dates": dates,
            "min_date": dates[0],
            "max_date": dates[-1],
            "total": len(dates),
            "dataset": state["id"],
            "dataset_label": state["label"],
            "year_start": year_start,
            "year_end": year_end,
        }
    )


@app.get("/variables")
async def get_available_variables(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    return JSONResponse(
        content={
            "variables": state["variables"],
            "default_variable": state["default_variable"],
            "dataset": state["id"],
            "dataset_label": state["label"],
            "year_start": year_start,
            "year_end": year_end,
        }
    )


@app.get("/elevation-range")
async def get_elevation_range(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    return {"min_elevation": FIXED_ELEV_MIN, "max_elevation": FIXED_ELEV_MAX}


@app.get("/data")
async def get_data(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    variable: Optional[str] = Query(None, description="Variable name"),
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD") from exc

    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)

    start_time = datetime.now()
    data = query_data(state, date, elev_min, elev_max, var_name)
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    logger.info(
        f"[{state['id']}] Query {date} [{elev_min}-{elev_max}m] {var_name}: "
        f"{len(data)} points in {query_time:.0f}ms"
    )
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "date": date,
            "elev_min": elev_min,
            "elev_max": elev_max,
            "variable": var_name,
            "year_start": year_start,
            "year_end": year_end,
            "data": data,
            "count": len(data),
            "query_time_ms": round(query_time, 2),
        }
    )


@app.get("/basin-mean")
async def get_basin_mean(
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    variable: Optional[str] = Query(None, description="Variable name"),
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    try:
        datetime.strptime(start_date, "%Y-%m-%d")
        datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD") from exc

    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)

    start_time = datetime.now()
    data = calculate_basin_mean(state, start_date, end_date, elev_min, elev_max, var_name)
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    logger.info(
        f"[{state['id']}] Basin mean [{start_date} to {end_date}] [{elev_min}-{elev_max}m] {var_name}: "
        f"{len(data)} days in {query_time:.0f}ms"
    )
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "start_date": start_date,
            "end_date": end_date,
            "elev_min": elev_min,
            "elev_max": elev_max,
            "variable": var_name,
            "year_start": year_start,
            "year_end": year_end,
            "data": data,
            "count": len(data),
            "query_time_ms": round(query_time, 2),
        }
    )


@app.get("/region-mean")
async def get_region_mean(
    year: int = Query(..., description="Year (YYYY)"),
    min_lat: float = Query(..., description="Minimum latitude"),
    max_lat: float = Query(..., description="Maximum latitude"),
    min_lon: float = Query(..., description="Minimum longitude"),
    max_lon: float = Query(..., description="Maximum longitude"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    variable: Optional[str] = Query(None, description="Variable name"),
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)
    min_lat, max_lat = sorted([min_lat, max_lat])
    min_lon, max_lon = sorted([min_lon, max_lon])

    start_time = datetime.now()
    data = calculate_region_mean(
        state, year, min_lat, max_lat, min_lon, max_lon, elev_min, elev_max, var_name
    )
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    logger.info(
        f"[{state['id']}] Region mean {year} [{min_lat},{max_lat}]x[{min_lon},{max_lon}] "
        f"[{elev_min}-{elev_max}m] {var_name}: {len(data)} days in {query_time:.0f}ms"
    )
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "year": year,
            "bounds": {
                "min_lat": min_lat,
                "max_lat": max_lat,
                "min_lon": min_lon,
                "max_lon": max_lon,
            },
            "elev_min": elev_min,
            "elev_max": elev_max,
            "variable": var_name,
            "year_start": year_start,
            "year_end": year_end,
            "data": data,
            "count": len(data),
            "query_time_ms": round(query_time, 2),
        }
    )


@app.get("/stats")
async def get_stats(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    parquet_files = sorted(state["path"].glob("*.parquet"))
    if not parquet_files:
        raise HTTPException(status_code=404, detail=f"No data files found for dataset '{state['id']}'")

    filtered_files = select_files_for_year_range(parquet_files, year_start, year_end)
    total_size = sum(file_path.stat().st_size for file_path in filtered_files)
    date_col = state["date_col"]
    sample_columns = tuple(dict.fromkeys([date_col] + state["all_columns"]))
    if filtered_files:
        sample_file = filtered_files[0]
    else:
        sample_file = parquet_files[0]
    df = read_parquet_subset(str(sample_file), sample_columns, date_col)

    return {
        "dataset": state["id"],
        "dataset_label": state["label"],
        "dataset_path": str(state["path"]),
        "total_files": len(filtered_files),
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "total_dates": len(state["date_index"]),
        "year_start": year_start,
        "year_end": year_end,
        "variables": state["variables"],
        "sample_stats": {
            "columns": list(df.columns),
            "sample_records": len(df),
        },
    }


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    """
    Serve frontend index.html for non-API paths in packaged/browser mode.
    Keeps API routes intact (they are matched before this catch-all route).
    """
    index_path = FRONTEND_DIST_DIR / "index.html"
    if index_path.exists() and "." not in full_path:
        return FileResponse(path=str(index_path), media_type="text/html")
    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn

    init_dataset_state()
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
