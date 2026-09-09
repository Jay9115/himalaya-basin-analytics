"""
FastAPI backend for local geospatial visualization.
Supports multiple datasets with lazy indexing.
"""
from datetime import date, datetime
from collections import OrderedDict
import csv
import hashlib
import json
import mimetypes
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import logging
import os
import re
import sys
import warnings
from contextlib import asynccontextmanager

from pydantic import BaseModel
import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.parquet as pq
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from nc_ingest import (
    add_uploaded_dataset_entry,
    convert_nc_to_parquet,
    generate_dataset_id,
    list_uploaded_dataset_configs,
    slugify,
)
from custom_operations.data_access import OperationBackendHooks, OperationDataLoader
from custom_operations.router import build_custom_operations_router
from export_data.router import build_export_router
from research_studio.framework_router import build_research_framework_router
from research_studio.router import build_research_router
from project_workspace import build_project_workspace_router


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup actions
    ensure_uploaded_nc_dirs()
    init_dataset_state()
    load_subregion_index()
    logger.info("Dataset state initialized")
    try:
        yield
    finally:
        # Place for graceful shutdown actions if needed
        pass


app = FastAPI(title="Himalayan Basin Analytics API", lifespan=lifespan)

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


def resolve_database_dir() -> Path:
    """Resolve active database directory from environment variable, config file, or default."""
    env_dir = os.environ.get("DATABASE_DIR")
    if env_dir:
        p = Path(env_dir.strip().strip('"').strip("'")).resolve()
        if p.exists():
            return p

    for candidate in [
        WEBAPP_DIR / "dataset_path.txt",
        WEBAPP_DIR / "backend" / "dataset_path.txt",
    ]:
        if candidate.exists():
            try:
                line = candidate.read_text("utf-8").strip().strip('"').strip("'")
                if line and Path(line).exists():
                    return Path(line).resolve()
            except Exception:
                pass

    return WEBAPP_DIR / "Database"


DATABASE_DIR = resolve_database_dir()
FRONTEND_DIST_CANDIDATES = [
    WEBAPP_DIR / "frontend_dist",
    WEBAPP_DIR / "frontend" / "dist",
    WEBAPP_DIR / "dist",
]
FRONTEND_DIST_DIR = next((p for p in FRONTEND_DIST_CANDIDATES if p.exists()), FRONTEND_DIST_CANDIDATES[0])

BASE_DATASET_CONFIGS: Dict[str, Dict] = {
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
    "sphy_model": {
        "label": "SPHY Model",
        "paths": [
            DATABASE_DIR / "SPHY_Model",
        ],
        # Zero melt cells dominate these rasters and do not add information to
        # the interactive map. Exclude them during the Parquet read so they are
        # neither serialized by the API nor loaded by the browser.
        "map_exclude_zero_variables": ["GMel", "SMel"],
    },
    "chirps": {
        "label": "CHIRPS Precipitation",
        "paths": [
            DATABASE_DIR / "CHIRPS",
        ],
    },
    "mod10a1_monthly": {
        "label": "MOD10A1 Monthly Snow/Albedo",
        "paths": [
            DATABASE_DIR / "MOD10A1_Parquet",
        ],
        "storage": "parquet",
        "file_pattern": "MOD10A1_*.parquet",
        "default_elevation": 500.0,
        "map_max_points": 75000,
        "interactive_sample_column": "_map_sample",
        "hotspot_sample_column": "_map_sample",
    },
    "discharge_network": {
        "label": "Discharge Network",
        "paths": [
            DATABASE_DIR / "Discharge_Geopar",
        ],
        "storage": "geoparquet",
        "file_pattern": "QAll_*.parquet",
        "default_elevation": 500.0,
        "map_max_points": 80000,
    },
    "himalaya_dem": {
        "label": "Himalaya SRTM DEM",
        "paths": [
            DATABASE_DIR / "DEM",
        ],
        "storage": "geoparquet",
        "file_pattern": "Himalaya_SRTM_DEM-*.parquet",
        # SRTM is a static terrain reference. The mission acquisition date is
        # used only to fit the dashboard's shared date/year selection model.
        "reference_date": "2000-02-11",
        "variable_columns": ["elevation_m"],
        "feature_kind": "dem",
        "elevation_is_value": True,
        "map_max_points": 75000,
    },
}
UPLOADED_NC_ROOT = DATABASE_DIR / "Uploaded_NC"
UPLOADED_NC_MANIFEST = UPLOADED_NC_ROOT / "uploaded_nc_datasets.json"
UPLOADED_NC_FILES_DIR = UPLOADED_NC_ROOT / "_uploads"


def _update_dataset_base_paths(new_db_dir: Path) -> None:
    """Dynamically update all dataset paths when database directory changes."""
    global DATABASE_DIR, UPLOADED_NC_ROOT, UPLOADED_NC_MANIFEST, UPLOADED_NC_FILES_DIR
    DATABASE_DIR = new_db_dir
    UPLOADED_NC_ROOT = DATABASE_DIR / "Uploaded_NC"
    UPLOADED_NC_MANIFEST = UPLOADED_NC_ROOT / "uploaded_nc_datasets.json"
    UPLOADED_NC_FILES_DIR = UPLOADED_NC_ROOT / "_uploads"

    BASE_DATASET_CONFIGS["era5"]["paths"] = [DATABASE_DIR / "Full_Shape_ERA5"]
    BASE_DATASET_CONFIGS["cmip6"]["paths"] = [DATABASE_DIR / "Full_shape_CMIP6"]
    BASE_DATASET_CONFIGS["sphy_model"]["paths"] = [DATABASE_DIR / "SPHY_Model"]
    BASE_DATASET_CONFIGS["chirps"]["paths"] = [DATABASE_DIR / "CHIRPS"]
    BASE_DATASET_CONFIGS["mod10a1_monthly"]["paths"] = [
        DATABASE_DIR / "MOD10A1_Parquet",
        DATABASE_DIR / "MOD10A1_Monthly_GeoTIFF",
    ]
    BASE_DATASET_CONFIGS["discharge_network"]["paths"] = [DATABASE_DIR / "Discharge_Geopar"]
    BASE_DATASET_CONFIGS["himalaya_dem"]["paths"] = [
        DATABASE_DIR / "DEM",
        DATABASE_DIR / "Himalaya_DEM",
    ]


DATASET_CONFIGS: Dict[str, Dict] = {}

DEFAULT_DATASET_ID = "era5"
EXCLUDE_COLUMNS = {"system:index", ".geo", "_map_sample"}
DATE_CANDIDATES = ["date", "Date", "DATE"]
LAT_CANDIDATES = ["latitude", "lat", "Latitude", "Lat"]
LON_CANDIDATES = ["longitude", "lon", "Longitude", "Lon"]
ELEV_CANDIDATES = ["elevation_m", "elev", "elevation", "Elevation_m"]
FIXED_ELEV_MIN = 500.0
FIXED_ELEV_MAX = 9000.0
YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")
PARQUET_STORAGE = "parquet"
GEOTIFF_STORAGE = "geotiff"
GEOPARQUET_STORAGE = "geoparquet"
GEOTIFF_DATE_PATTERN = re.compile(r"MOD10A1_(\d{4})_(\d{2})$", re.IGNORECASE)
DISCHARGE_DATE_PATTERN = re.compile(r"QAll_(\d{4})(\d{2})(\d{2})$", re.IGNORECASE)
DISCHARGE_VALUE_COL = "DN"
GEOTIFF_DATE_COL = "date"
GEOTIFF_LAT_COL = "latitude"
GEOTIFF_LON_COL = "longitude"
GEOTIFF_ELEV_COL = "elevation_m"
GEOTIFF_DEFAULT_ELEVATION = 500.0
GEOTIFF_DEFAULT_MAP_MAX_POINTS = 75000
SUBREGION_ID_CANDIDATES = ["Subbasin", "subbasin", "GRIDCODE", "HydroID", "OBJECTID", "id", "ID"]
SUBREGION_LABEL_CANDIDATES = [
    "Bname",
    "BasinName",
    "SubbasinName",
    "Name",
    "name",
    "District",
]

# Keeps metadata + index cache for each dataset id.
DATASET_STATE: Dict[str, Dict] = {}
SUBREGION_STATE: Dict[str, Dict] = {
    "loaded": False,
    "source_path": MAP_ASSETS_DIR / "upper_indus_basin.geojson",
    "index": {},
    "list": [],
}
GLACIER_SHAPE_ROOT = WEBAPP_DIR / "Glacier_shp"
GLACIER_ID_PREFIX = "glacier:"
GLACIER_REGION_FOLDER_PATTERN = "RGI2000-v7.0-G-*"
GLACIER_ID_COL = "rgi_id"
GLACIER_NAME_COL = "glac_name"
GLACIER_CENLAT_COL = "cenlat"
GLACIER_CENLON_COL = "cenlon"
GLACIER_AREA_COL = "area_km2"
GLIMS_FOLDER_PATTERN = "glims_download_*"
GLIMS_POLYGON_GEOPARQUET_FILES = [
    "glims_polygons_geoparquet.parquet",
    "glims_polygons.parquet",
]
GLIMS_POLYGON_SHAPE_FILE = "glims_polygons.shp"
GLIMS_ID_COL = "glac_id"
GLIMS_NAME_COL = "glac_name"
GLIMS_AREA_COL = "db_area"
GLIMS_DATE_COL = "src_date"
GLIMS_LINE_TYPE_COL = "line_type"
GLIMS_GLACIER_BOUNDARY_VALUE = "glac_bound"
GLACIER_OVERVIEW_DEFAULT_MAX_FEATURES = 3500
GLACIER_OVERVIEW_MAX_FEATURES_LIMIT = 20000
GLACIER_OVERVIEW_READ_MULTIPLIER = 2
GLACIER_OVERVIEW_READ_MAX_ROWS = 6000
GLACIER_OVERVIEW_CACHE_MAX_ENTRIES = 12
GLACIER_ROI_NEARBY_BUFFER_KM = 5.0

try:
    import pyogrio  # type: ignore
except Exception:
    pyogrio = None

try:
    import rasterio  # type: ignore
except Exception:
    rasterio = None

try:
    import geopandas as gpd  # type: ignore
except Exception:
    gpd = None

try:
    from shapely import contains_xy as shapely_contains_xy  # type: ignore
    from shapely.geometry import shape as shapely_shape  # type: ignore
except Exception:
    shapely_contains_xy = None
    shapely_shape = None

OUTCOMES_DIR = WEBAPP_DIR / "Outcomes"
LONG_TERM_HOTSPOT_DIR = OUTCOMES_DIR / "Long_term_hotspot"
LONG_TERM_HOTSPOT_OUTPUTS_DIR = LONG_TERM_HOTSPOT_DIR / "Outputs"
LONG_TERM_HOTSPOT_PARQUET = LONG_TERM_HOTSPOT_OUTPUTS_DIR / "long_term_hotspot_band_means.parquet"
LONG_TERM_HOTSPOT_META = LONG_TERM_HOTSPOT_OUTPUTS_DIR / "long_term_hotspot_metadata.json"
LONG_TERM_HOTSPOT_DIFF_PARQUET = LONG_TERM_HOTSPOT_OUTPUTS_DIR / "long_term_hotspot_band_differences.parquet"
LONG_TERM_HOTSPOT_DIFF_META = LONG_TERM_HOTSPOT_OUTPUTS_DIR / "long_term_hotspot_band_differences_metadata.json"

LONG_TERM_HOTSPOT_15YR_DIR = OUTCOMES_DIR / "Long_term_hotspot_15yr"
LONG_TERM_HOTSPOT_15YR_OUTPUTS_DIR = LONG_TERM_HOTSPOT_15YR_DIR / "Outputs"
LONG_TERM_HOTSPOT_15YR_PARQUET = LONG_TERM_HOTSPOT_15YR_OUTPUTS_DIR / "long_term_hotspot_15yr_band_values.parquet"
LONG_TERM_HOTSPOT_15YR_META = LONG_TERM_HOTSPOT_15YR_OUTPUTS_DIR / "long_term_hotspot_15yr_metadata.json"
LONG_TERM_HOTSPOT_15YR_DIFF_PARQUET = LONG_TERM_HOTSPOT_15YR_OUTPUTS_DIR / "long_term_hotspot_15yr_band_differences.parquet"
LONG_TERM_HOTSPOT_15YR_DIFF_META = LONG_TERM_HOTSPOT_15YR_OUTPUTS_DIR / "long_term_hotspot_15yr_band_differences_metadata.json"

OUTCOME_CONFIGS: Dict[str, Dict[str, Any]] = {
    "long_term_hotspot": {
        "label": "Long Term Hotspot Analysis - 25 Year Bands",
        "description": "Precomputed 25-year ERA5 spatial means and later-minus-earlier change maps",
        "dataset": "era5",
        "parquet": LONG_TERM_HOTSPOT_PARQUET,
        "meta": LONG_TERM_HOTSPOT_META,
        "diff_parquet": LONG_TERM_HOTSPOT_DIFF_PARQUET,
        "diff_meta": LONG_TERM_HOTSPOT_DIFF_META,
        "output_directory": "Outcomes/Long_term_hotspot/Outputs",
        "generation_script": "Outcomes/Long_term_hotspot/Scripts/compute_era5_band_means.py",
    },
    "long_term_hotspot_15yr": {
        "label": "Long Term Hotspot Analysis - 15 Year Bands",
        "description": "Five 15-year ERA5-Land and CHIRPS bands; precipitation and snow use sums, other variables use means",
        "dataset": "era5_chirps",
        "parquet": LONG_TERM_HOTSPOT_15YR_PARQUET,
        "meta": LONG_TERM_HOTSPOT_15YR_META,
        "diff_parquet": LONG_TERM_HOTSPOT_15YR_DIFF_PARQUET,
        "diff_meta": LONG_TERM_HOTSPOT_15YR_DIFF_META,
        "output_directory": "Outcomes/Long_term_hotspot_15yr/Outputs",
        "generation_script": "Outcomes/Long_term_hotspot_15yr/Scripts/compute_era5_15yr_bands.py",
    },
}

OUTCOME_STATE: Dict[str, Dict[str, Any]] = {
    outcome_id: {
        "loaded": False,
        "parquet_mtime": None,
        "meta_mtime": None,
        "df": pd.DataFrame(),
        "diff_df": pd.DataFrame(),
        "meta": {},
        "diff_meta": {},
        "variables": [],
        "bands": [],
        "comparisons": [],
    }
    for outcome_id in OUTCOME_CONFIGS
}

GLACIER_SOURCE_STATE: Dict[str, Any] = {
    "signature": None,
    "sources": [],
}
GLACIER_OVERVIEW_CACHE: "OrderedDict[Tuple[Any, ...], Dict[str, Any]]" = OrderedDict()


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
    if asset_path.suffix.lower() == ".pbf":
        return "application/x-protobuf"
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


def _ring_to_numpy(ring_coords: List[List[float]]) -> Optional[np.ndarray]:
    try:
        ring = np.asarray(ring_coords, dtype=float)
    except Exception:
        return None
    if ring.ndim != 2 or ring.shape[0] < 3 or ring.shape[1] < 2:
        return None
    ring = ring[:, :2]
    if not np.allclose(ring[0], ring[-1]):
        ring = np.vstack([ring, ring[0]])
    if ring.shape[0] < 4:
        return None
    return ring


def _feature_to_polygons(geometry: Dict[str, Any]) -> List[Dict[str, Any]]:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    polygons: List[Dict[str, Any]] = []

    if geom_type == "Polygon":
        coord_sets = [coords]
    elif geom_type == "MultiPolygon":
        coord_sets = coords
    else:
        return polygons

    for polygon_coords in coord_sets:
        if not polygon_coords:
            continue
        outer = _ring_to_numpy(polygon_coords[0])
        if outer is None:
            continue
        holes = []
        for hole_coords in polygon_coords[1:]:
            hole = _ring_to_numpy(hole_coords)
            if hole is not None:
                holes.append(hole)
        polygons.append({"outer": outer, "holes": holes})
    return polygons


def _extract_subregion_id(properties: Dict[str, Any]) -> Optional[str]:
    for key in SUBREGION_ID_CANDIDATES:
        if key not in properties:
            continue
        value = properties.get(key)
        if value is None:
            continue
        value_str = str(value).strip()
        if value_str:
            return value_str
    return None


def _extract_subregion_label(properties: Dict[str, Any], region_id: str) -> str:
    for key in SUBREGION_LABEL_CANDIDATES:
        if key not in properties:
            continue
        value = properties.get(key)
        if value is None:
            continue
        value_str = str(value).strip()
        if value_str:
            return value_str
    return f"Subbasin {region_id}"


def _compute_polygon_bounds(polygons: List[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    if not polygons:
        return None
    min_lon = min(float(np.min(poly["outer"][:, 0])) for poly in polygons)
    max_lon = max(float(np.max(poly["outer"][:, 0])) for poly in polygons)
    min_lat = min(float(np.min(poly["outer"][:, 1])) for poly in polygons)
    max_lat = max(float(np.max(poly["outer"][:, 1])) for poly in polygons)
    return {
        "min_lon": min_lon,
        "max_lon": max_lon,
        "min_lat": min_lat,
        "max_lat": max_lat,
    }


def _parse_aoi_geojson(aoi_geojson: Optional[str]) -> Optional[Dict[str, Any]]:
    if not aoi_geojson:
        return None

    try:
        payload = json.loads(aoi_geojson)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid ROI polygon GeoJSON.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="ROI polygon must be a GeoJSON object.")

    properties = payload.get("properties") if isinstance(payload.get("properties"), dict) else {}
    geometry = payload.get("geometry") if payload.get("type") == "Feature" else payload
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise HTTPException(status_code=400, detail="ROI polygon must be a Polygon or MultiPolygon GeoJSON geometry.")

    polygons = _feature_to_polygons(geometry)
    bounds = _compute_polygon_bounds(polygons)
    if not polygons or not bounds:
        raise HTTPException(status_code=400, detail="ROI polygon has no valid rings.")

    if (
        bounds["min_lat"] < -90
        or bounds["max_lat"] > 90
        or bounds["min_lon"] < -180
        or bounds["max_lon"] > 180
    ):
        raise HTTPException(status_code=400, detail="ROI polygon coordinates are out of WGS84 bounds.")

    vertex_count = sum(max(0, int(poly["outer"].shape[0]) - 1) for poly in polygons)
    if vertex_count > 2000:
        raise HTTPException(status_code=400, detail="ROI polygon is too complex. Use 2000 vertices or fewer.")

    return {
        "id": str(properties.get("id") or "custom_aoi"),
        "label": str(properties.get("label") or properties.get("name") or "ROI"),
        "kind": "aoi",
        "bounds": bounds,
        "polygons": polygons,
        "geometry": geometry,
        "properties": properties,
    }


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        value_float = float(value)
        if np.isfinite(value_float):
            return value_float
    except Exception:
        return None
    return None


def _escape_sql_literal(value: str) -> str:
    return value.replace("'", "''")


def _ensure_glacier_vector_reader() -> str:
    global pyogrio
    global gpd

    if pyogrio is None:
        try:
            import pyogrio as _pyogrio  # type: ignore
            pyogrio = _pyogrio
        except Exception:
            pyogrio = None

    if pyogrio is not None:
        return "pyogrio"

    if gpd is None:
        try:
            import geopandas as _gpd  # type: ignore
            gpd = _gpd
        except Exception:
            gpd = None

    if gpd is not None:
        return "geopandas"

    raise HTTPException(
        status_code=500,
        detail="Glacier geometry support requires pyogrio or geopandas in backend environment.",
    )


def _find_glims_polygon_source(glims_dir: Path) -> Optional[Path]:
    for filename in GLIMS_POLYGON_GEOPARQUET_FILES:
        parquet_path = (glims_dir / filename).resolve()
        if parquet_path.exists():
            return parquet_path

    shp_path = (glims_dir / GLIMS_POLYGON_SHAPE_FILE).resolve()
    if shp_path.exists():
        return shp_path
    return None


def _glacier_source_path(subregion: Dict[str, Any]) -> Optional[Path]:
    raw_path = subregion.get("vector_path") or subregion.get("shapefile_path")
    if not raw_path:
        return None
    return Path(str(raw_path))


def _read_glacier_dataframe(
    vector_path: Path,
    *,
    columns: Optional[List[str]] = None,
    where: Optional[str] = None,
    bbox: Optional[Tuple[float, float, float, float]] = None,
    max_features: Optional[int] = None,
):
    global gpd
    reader = _ensure_glacier_vector_reader()
    vector_path = Path(vector_path)

    if vector_path.suffix.lower() in {".parquet", ".geoparquet"}:
        if gpd is None:
            try:
                import geopandas as _gpd  # type: ignore
                gpd = _gpd
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail="GeoParquet glacier support requires geopandas in backend environment.",
                ) from exc

        read_columns = list(columns or [])
        if read_columns and "geometry" not in read_columns:
            read_columns.append("geometry")

        read_kwargs: Dict[str, Any] = {}
        if read_columns:
            read_kwargs["columns"] = read_columns
        if bbox:
            read_kwargs["bbox"] = bbox

        where_match = None
        if where:
            where_match = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$", where)
            if where_match:
                where_col = where_match.group(1)
                where_value = where_match.group(2).replace("''", "'")
                read_kwargs["filters"] = [(where_col, "=", where_value)]

        try:
            frame = gpd.read_parquet(vector_path, **read_kwargs)
        except (TypeError, ValueError):
            fallback_kwargs = dict(read_kwargs)
            fallback_kwargs.pop("bbox", None)
            fallback_kwargs.pop("filters", None)
            frame = gpd.read_parquet(vector_path, **fallback_kwargs)
            if bbox and hasattr(frame, "cx"):
                frame = frame.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]

        if where:
            match = where_match or re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$", where)
            if match:
                where_col = match.group(1)
                where_value = match.group(2).replace("''", "'")
                if where_col in frame.columns:
                    frame = frame[frame[where_col].astype(str).str.strip() == where_value]

        if max_features is not None and len(frame) > int(max_features):
            frame = frame.head(int(max_features))

        return frame

    if reader == "pyogrio":
        kwargs: Dict[str, Any] = {}
        if columns:
            kwargs["columns"] = columns
        if where:
            kwargs["where"] = where
        if bbox:
            kwargs["bbox"] = bbox
        if max_features is not None:
            kwargs["max_features"] = int(max_features)

        try:
            return pyogrio.read_dataframe(vector_path, **kwargs)
        except TypeError:
            # Older builds may not accept bbox; apply bbox client-side as fallback.
            fallback_kwargs = dict(kwargs)
            fallback_kwargs.pop("bbox", None)
            frame = pyogrio.read_dataframe(vector_path, **fallback_kwargs)
            if bbox and hasattr(frame, "cx"):
                frame = frame.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]
            return frame

    read_kwargs: Dict[str, Any] = {}
    if bbox:
        read_kwargs["bbox"] = bbox
    if columns:
        read_kwargs["columns"] = columns
    if max_features is not None:
        read_kwargs["rows"] = slice(0, int(max_features))

    try:
        frame = gpd.read_file(vector_path, **read_kwargs)
    except TypeError:
        fallback_kwargs = {}
        if bbox:
            fallback_kwargs["bbox"] = bbox
        if max_features is not None:
            fallback_kwargs["rows"] = slice(0, int(max_features))
        frame = gpd.read_file(vector_path, **fallback_kwargs)

    if columns:
        keep_columns = [column for column in columns if column in frame.columns]
        if "geometry" in frame.columns and "geometry" not in keep_columns:
            keep_columns.append("geometry")
        if keep_columns:
            frame = frame[keep_columns]

    if where:
        match = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$", where)
        if match:
            where_col = match.group(1)
            where_value = match.group(2).replace("''", "'")
            if where_col in frame.columns:
                frame = frame[frame[where_col].astype(str).str.strip() == where_value]

    return frame


def _glacier_simplify_tolerance(zoom: float) -> float:
    zoom = float(max(0.0, min(zoom, 22.0)))
    if zoom >= 10.0:
        return 0.0
    if zoom >= 8.0:
        return 0.00025
    if zoom >= 7.0:
        return 0.0006
    if zoom >= 6.0:
        return 0.0012
    if zoom >= 5.0:
        return 0.0025
    return 0.0045


def _normalize_glacier_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if text.lower() in {"none", "null", "nan", "n/a", "na", "-"}:
        return ""
    return text


def _discover_glacier_polygon_sources() -> Tuple[Tuple[Any, ...], List[Dict[str, Any]]]:
    if not GLACIER_SHAPE_ROOT.exists():
        GLACIER_SOURCE_STATE["signature"] = tuple()
        GLACIER_SOURCE_STATE["sources"] = []
        GLACIER_OVERVIEW_CACHE.clear()
        return tuple(), []

    sources: List[Dict[str, Any]] = []
    for region_dir in sorted(GLACIER_SHAPE_ROOT.glob(GLACIER_REGION_FOLDER_PATTERN)):
        if not region_dir.is_dir():
            continue
        shp_files = sorted(region_dir.glob("*.shp"))
        if not shp_files:
            continue
        sources.append(
            {
                "kind": "rgi",
                "path": shp_files[0].resolve(),
                "id_col": GLACIER_ID_COL,
                "name_col": GLACIER_NAME_COL,
                "area_col": GLACIER_AREA_COL,
                "date_col": None,
                "line_type_col": None,
                "line_type_value": None,
            }
        )

    glims_dirs = sorted([path for path in GLACIER_SHAPE_ROOT.glob(GLIMS_FOLDER_PATTERN) if path.is_dir()])
    glims_geoparquet_dirs = [
        path
        for path in glims_dirs
        if any((path / filename).exists() for filename in GLIMS_POLYGON_GEOPARQUET_FILES)
    ]
    glims_dirs_to_use = glims_geoparquet_dirs or glims_dirs

    for glims_dir in glims_dirs_to_use:
        if not glims_dir.is_dir():
            continue
        vector_path = _find_glims_polygon_source(glims_dir)
        if not vector_path:
            continue
        sources.append(
            {
                "kind": "glims",
                "path": vector_path,
                "id_col": GLIMS_ID_COL,
                "name_col": GLIMS_NAME_COL,
                "area_col": GLIMS_AREA_COL,
                "date_col": GLIMS_DATE_COL,
                "line_type_col": GLIMS_LINE_TYPE_COL,
                "line_type_value": GLIMS_GLACIER_BOUNDARY_VALUE,
            }
        )

    signature_parts: List[Any] = []
    for source in sources:
        source_path = Path(source["path"])
        try:
            stat = source_path.stat()
            signature_parts.append((str(source_path), stat.st_mtime_ns, stat.st_size))
        except Exception:
            signature_parts.append((str(source_path), None, None))
    signature = tuple(signature_parts)

    if GLACIER_SOURCE_STATE.get("signature") != signature:
        GLACIER_SOURCE_STATE["signature"] = signature
        GLACIER_SOURCE_STATE["sources"] = sources
        GLACIER_OVERVIEW_CACHE.clear()
    else:
        sources = GLACIER_SOURCE_STATE.get("sources", [])

    return signature, sources


def _glacier_cache_quantum(zoom: float) -> float:
    if zoom < 5.0:
        return 0.5
    if zoom < 6.5:
        return 0.25
    if zoom < 8.0:
        return 0.1
    return 0.05


def _make_glacier_overview_cache_key(
    source_signature: Tuple[Any, ...],
    bbox: Optional[Tuple[float, float, float, float]],
    zoom: float,
    max_features: int,
    simplify_tolerance: float,
    subregion_id: Optional[str] = None,
    aoi_signature: str = "",
    nearby_buffer_km: float = 0.0,
) -> Tuple[Any, ...]:
    quantized_bbox = None
    if bbox:
        quantum = _glacier_cache_quantum(zoom)
        quantized_bbox = tuple(round(round(value / quantum) * quantum, 5) for value in bbox)
    return (
        source_signature,
        quantized_bbox,
        round(float(zoom), 2),
        int(max_features),
        round(float(simplify_tolerance), 6),
        str(subregion_id or ""),
        str(aoi_signature or ""),
        round(float(nearby_buffer_km or 0.0), 3),
    )


def _build_glacier_source_lookup() -> Dict[Path, Dict[str, Any]]:
    if not SUBREGION_STATE["loaded"]:
        load_subregion_index()

    lookup: Dict[Path, Dict[str, Any]] = {}
    for item in SUBREGION_STATE["index"].values():
        if item.get("kind") != "glacier":
            continue

        native_id = str(item.get("native_id") or "").strip()
        vector_path = _glacier_source_path(item)
        if not native_id or not vector_path:
            continue

        source = lookup.setdefault(vector_path, {"ids": set(), "name_by_id": {}})
        source["ids"].add(native_id)

        properties = item.get("properties") or {}
        glacier_name = str(properties.get("glacier_name") or "").strip()
        if glacier_name:
            source["name_by_id"][native_id] = glacier_name

    return lookup


def _validate_glacier_bbox(
    min_lat: Optional[float],
    max_lat: Optional[float],
    min_lon: Optional[float],
    max_lon: Optional[float],
) -> Optional[Tuple[float, float, float, float]]:
    provided = [min_lat, max_lat, min_lon, max_lon]
    if not any(value is not None for value in provided):
        return None

    if not all(value is not None for value in provided):
        raise HTTPException(
            status_code=400,
            detail="Provide all bbox values together: min_lat, max_lat, min_lon, max_lon.",
        )

    assert min_lat is not None and max_lat is not None and min_lon is not None and max_lon is not None
    min_lat = float(min_lat)
    max_lat = float(max_lat)
    min_lon = float(min_lon)
    max_lon = float(max_lon)

    if min_lat < -90 or max_lat > 90 or min_lon < -180 or max_lon > 180:
        raise HTTPException(status_code=400, detail="BBox coordinates are out of WGS84 bounds.")

    south = min(min_lat, max_lat)
    north = max(min_lat, max_lat)
    west = min(min_lon, max_lon)
    east = max(min_lon, max_lon)
    return (west, south, east, north)


def _expand_wgs84_bbox_by_km(
    bbox: Tuple[float, float, float, float],
    buffer_km: float,
) -> Tuple[float, float, float, float]:
    if buffer_km <= 0:
        return bbox
    west, south, east, north = bbox
    mid_lat = max(-89.0, min(89.0, (float(south) + float(north)) / 2.0))
    lat_delta = float(buffer_km) / 111.32
    lon_scale = max(0.2, abs(np.cos(np.deg2rad(mid_lat))))
    lon_delta = float(buffer_km) / (111.32 * lon_scale)
    return (
        max(-180.0, float(west) - lon_delta),
        max(-90.0, float(south) - lat_delta),
        min(180.0, float(east) + lon_delta),
        min(90.0, float(north) + lat_delta),
    )


def _make_aoi_cache_signature(aoi_subregion: Optional[Dict[str, Any]]) -> str:
    if not aoi_subregion:
        return ""
    geometry = aoi_subregion.get("geometry") or {}
    try:
        payload = json.dumps(geometry, sort_keys=True, separators=(",", ":"))
    except TypeError:
        payload = str(geometry)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _build_nearby_glacier_selection_geometry(
    subregion: Optional[Dict[str, Any]],
    buffer_km: float,
):
    geometry = _get_subregion_shapely_geometry(subregion) if subregion else None
    if geometry is None or buffer_km <= 0:
        return geometry
    bounds = subregion.get("bounds") or {}
    mid_lat = (float(bounds.get("min_lat", 0.0)) + float(bounds.get("max_lat", 0.0))) / 2.0
    lat_delta = float(buffer_km) / 111.32
    lon_scale = max(0.2, abs(np.cos(np.deg2rad(max(-89.0, min(89.0, mid_lat))))))
    lon_delta = float(buffer_km) / (111.32 * lon_scale)
    try:
        return geometry.buffer(max(lat_delta, lon_delta))
    except Exception:
        return geometry


def _load_glacier_geometry(subregion: Dict[str, Any]) -> None:
    if subregion.get("polygons") and subregion.get("bounds") and subregion.get("geometry"):
        return

    vector_path = _glacier_source_path(subregion)
    rgi_id = str(subregion.get("native_id") or "").strip()
    if not vector_path or not rgi_id:
        raise HTTPException(status_code=500, detail="Glacier subregion metadata is incomplete.")

    if not vector_path.exists():
        raise HTTPException(status_code=500, detail=f"Glacier vector source missing: {vector_path}")

    source_id_col = str(subregion.get("source_id_col") or GLACIER_ID_COL).strip() or GLACIER_ID_COL
    where = f"{source_id_col} = '{_escape_sql_literal(rgi_id)}'"
    try:
        frame = _read_glacier_dataframe(vector_path, where=where)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read glacier geometry for '{rgi_id}'.",
        ) from exc

    if frame.empty:
        raise HTTPException(status_code=404, detail=f"Glacier geometry not found for '{rgi_id}'.")

    geometry_obj = frame.geometry.iloc[0]
    if geometry_obj is None or geometry_obj.is_empty:
        raise HTTPException(status_code=500, detail=f"Glacier geometry is empty for '{rgi_id}'.")

    geometry = geometry_obj.__geo_interface__
    polygons = _feature_to_polygons(geometry)
    bounds = _compute_polygon_bounds(polygons)
    if not polygons or not bounds:
        raise HTTPException(status_code=500, detail=f"Glacier polygon parsing failed for '{rgi_id}'.")

    subregion["geometry"] = geometry
    subregion["polygons"] = polygons
    subregion["bounds"] = bounds


def _append_glacier_subregions(
    index: Dict[str, Dict[str, Any]],
    listing: List[Dict[str, Any]],
    basin_mask_subregion: Optional[Dict[str, Any]],
) -> int:
    if not GLACIER_SHAPE_ROOT.exists():
        logger.info("Glacier shape root not found: %s", GLACIER_SHAPE_ROOT)
        return 0

    region_dirs = sorted([path for path in GLACIER_SHAPE_ROOT.glob(GLACIER_REGION_FOLDER_PATTERN) if path.is_dir()])
    if not region_dirs:
        logger.info("No glacier region folders found in %s", GLACIER_SHAPE_ROOT)

    added = 0
    for region_dir in region_dirs:
        attr_files = sorted(region_dir.glob("*-attributes.csv"))
        shp_files = sorted(region_dir.glob("*.shp"))
        if not attr_files or not shp_files:
            logger.warning("Skipping glacier folder '%s': missing attributes CSV or SHP.", region_dir)
            continue

        attr_path = attr_files[0]
        shp_path = shp_files[0]
        region_label = region_dir.name.replace("RGI2000-v7.0-G-", "").replace("_", " ").title()

        try:
            with attr_path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                for row in reader:
                    native_id = str(row.get(GLACIER_ID_COL) or "").strip()
                    if not native_id:
                        continue

                    glacier_name = str(row.get(GLACIER_NAME_COL) or "").strip()
                    # Keep dropdown practical: include only named glaciers.
                    if not glacier_name:
                        continue

                    center_lat = _safe_float(row.get(GLACIER_CENLAT_COL))
                    center_lon = _safe_float(row.get(GLACIER_CENLON_COL))
                    if (
                        basin_mask_subregion
                        and center_lat is not None
                        and center_lon is not None
                    ):
                        bounds = basin_mask_subregion["bounds"]
                        if (
                            center_lon < bounds["min_lon"]
                            or center_lon > bounds["max_lon"]
                            or center_lat < bounds["min_lat"]
                            or center_lat > bounds["max_lat"]
                        ):
                            continue

                    subregion_id = f"{GLACIER_ID_PREFIX}{native_id}"
                    area_km2 = _safe_float(row.get(GLACIER_AREA_COL))
                    label = f"{glacier_name} ({native_id})"
                    properties = {
                        "rgi_id": native_id,
                        "glacier_name": glacier_name,
                        "region": region_label,
                        "area_km2": area_km2,
                    }
                    if center_lat is not None:
                        properties["center_lat"] = center_lat
                    if center_lon is not None:
                        properties["center_lon"] = center_lon

                    entry = {
                        "id": subregion_id,
                        "native_id": native_id,
                        "label": label,
                        "kind": "glacier",
                        "source_folder": str(region_dir),
                        "source_file": attr_path.name,
                        "vector_path": str(shp_path),
                        "shapefile_path": str(shp_path),
                        "source_id_col": GLACIER_ID_COL,
                        "properties": properties,
                        "geometry": None,
                        "polygons": None,
                        "bounds": None,
                    }
                    index[subregion_id] = entry
                    listing.append(
                        {
                            "id": subregion_id,
                            "label": label,
                            "kind": "glacier",
                            "bounds": None,
                        }
                    )
                    added += 1
        except Exception as exc:
            logger.warning("Failed to parse glacier metadata '%s': %s", attr_path, exc)

    if added > 0:
        return added

    glims_dirs = sorted([path for path in GLACIER_SHAPE_ROOT.glob(GLIMS_FOLDER_PATTERN) if path.is_dir()])
    glims_geoparquet_dirs = [
        path
        for path in glims_dirs
        if any((path / filename).exists() for filename in GLIMS_POLYGON_GEOPARQUET_FILES)
    ]
    glims_dirs = glims_geoparquet_dirs or glims_dirs
    if not glims_dirs:
        return added

    for glims_dir in glims_dirs:
        vector_path = _find_glims_polygon_source(glims_dir)
        if not vector_path:
            logger.warning("Skipping GLIMS glacier folder '%s': missing polygon vector source.", glims_dir)
            continue

        region_label = glims_dir.name.replace("glims_download_", "GLIMS ").replace("_", " ").title()
        basin_bbox = None
        if basin_mask_subregion:
            bounds = basin_mask_subregion["bounds"]
            basin_bbox = (
                bounds["min_lon"],
                bounds["min_lat"],
                bounds["max_lon"],
                bounds["max_lat"],
            )

        try:
            frame = _read_glacier_dataframe(
                vector_path,
                columns=[GLIMS_ID_COL, GLIMS_NAME_COL, GLIMS_AREA_COL],
                bbox=basin_bbox,
            )
        except Exception as exc:
            logger.warning("Failed to parse GLIMS glacier metadata '%s': %s", vector_path, exc)
            continue

        if frame.empty or GLIMS_ID_COL not in frame.columns:
            continue

        frame = frame.copy()
        frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty]
        if frame.empty:
            continue

        if basin_mask_subregion and frame.geometry is not None:
            bounds = basin_mask_subregion["bounds"]
            centroids = frame.geometry.representative_point()
            frame = frame[
                (centroids.x >= bounds["min_lon"])
                & (centroids.x <= bounds["max_lon"])
                & (centroids.y >= bounds["min_lat"])
                & (centroids.y <= bounds["max_lat"])
            ]
            if frame.empty:
                continue

        frame[GLIMS_ID_COL] = frame[GLIMS_ID_COL].astype(str).str.strip()
        frame = frame[frame[GLIMS_ID_COL] != ""]
        if frame.empty:
            continue

        if GLIMS_NAME_COL in frame.columns:
            frame["_normalized_glacier_name"] = frame[GLIMS_NAME_COL].map(_normalize_glacier_text)
            frame = frame[frame["_normalized_glacier_name"] != ""]
        else:
            frame["_normalized_glacier_name"] = ""
        if frame.empty:
            continue

        if GLIMS_AREA_COL in frame.columns:
            frame["_area_km2"] = pd.to_numeric(frame[GLIMS_AREA_COL], errors="coerce")
        else:
            frame["_area_km2"] = np.nan

        frame = frame.sort_values(by=["_area_km2"], ascending=[False], na_position="last")
        frame = frame.drop_duplicates(subset=[GLIMS_ID_COL], keep="first")

        for _, row in frame.iterrows():
            native_id = str(row.get(GLIMS_ID_COL) or "").strip()
            if not native_id:
                continue

            glacier_name = _normalize_glacier_text(row.get("_normalized_glacier_name")) or native_id
            area_km2 = _safe_float(row.get("_area_km2"))
            label = f"{glacier_name} ({native_id})"
            properties = {
                "rgi_id": native_id,
                "glacier_name": glacier_name,
                "region": region_label,
                "area_km2": area_km2,
            }

            entry = {
                "id": f"{GLACIER_ID_PREFIX}{native_id}",
                "native_id": native_id,
                "label": label,
                "kind": "glacier",
                "source_folder": str(glims_dir),
                "source_file": vector_path.name,
                "vector_path": str(vector_path),
                "shapefile_path": str(vector_path),
                "source_id_col": GLIMS_ID_COL,
                "properties": properties,
                "geometry": None,
                "polygons": None,
                "bounds": None,
            }
            index[entry["id"]] = entry
            listing.append(
                {
                    "id": entry["id"],
                    "label": label,
                    "kind": "glacier",
                    "bounds": None,
                }
            )
            added += 1

    return added


def _subregion_sort_key(item: Dict[str, Any]) -> Tuple[int, float, str]:
    item_id = str(item.get("id") or "")
    kind = str(item.get("kind") or "subregion")

    if kind == "subregion":
        try:
            return (0, float(item_id), str(item.get("label") or item_id))
        except Exception:
            return (0, float("inf"), str(item.get("label") or item_id))

    return (1, float("inf"), str(item.get("label") or item_id).lower())


def load_subregion_index() -> None:
    geojson_path = SUBREGION_STATE["source_path"]
    SUBREGION_STATE["loaded"] = False
    SUBREGION_STATE["index"] = {}
    SUBREGION_STATE["list"] = []

    if not geojson_path.exists():
        logger.warning("Subregion GeoJSON not found: %s", geojson_path)
        return

    try:
        geojson = json.loads(geojson_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.error("Failed to read subregion GeoJSON '%s': %s", geojson_path, exc)
        return

    features = geojson.get("features") or []
    index: Dict[str, Dict[str, Any]] = {}
    listing: List[Dict[str, Any]] = []

    basin_polygons: List[Dict[str, Any]] = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        polygons = _feature_to_polygons(geometry)
        if not polygons:
            continue
        bounds = _compute_polygon_bounds(polygons)
        if not bounds:
            continue

        region_id = _extract_subregion_id(properties)
        if not region_id:
            continue

        label = _extract_subregion_label(properties, region_id)

        payload = {
            "id": region_id,
            "label": label,
            "kind": "subregion",
            "bounds": bounds,
            "properties": properties,
            "geometry": geometry,
            "polygons": polygons,
        }
        index[region_id] = payload
        basin_polygons.extend(polygons)
        listing.append(
            {
                "id": region_id,
                "label": label,
                "kind": "subregion",
                "bounds": bounds,
            }
        )

    basin_mask_subregion: Optional[Dict[str, Any]] = None
    basin_bounds = _compute_polygon_bounds(basin_polygons)
    if basin_polygons and basin_bounds:
        basin_mask_subregion = {
            "bounds": basin_bounds,
            "polygons": basin_polygons,
        }

    glacier_added = _append_glacier_subregions(index, listing, basin_mask_subregion)
    listing.sort(key=_subregion_sort_key)

    SUBREGION_STATE["index"] = index
    SUBREGION_STATE["list"] = listing
    SUBREGION_STATE["loaded"] = True
    logger.info(
        "Loaded %d subregions (%d glacier selections) from %s",
        len(listing),
        glacier_added,
        geojson_path,
    )


def get_subregion(subregion_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not subregion_id:
        return None
    if not SUBREGION_STATE["loaded"]:
        load_subregion_index()
    region_id = str(subregion_id).strip()
    if not region_id:
        return None
    region = SUBREGION_STATE["index"].get(region_id)
    if region:
        if region.get("kind") == "glacier":
            _load_glacier_geometry(region)
        return region
    raise HTTPException(status_code=400, detail=f"Invalid subregion_id '{subregion_id}'")


def resolve_query_subregion(
    subregion_id: Optional[str],
    aoi_geojson: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Resolve either a named basin/glacier or the ROI polygon for data queries."""
    aoi_subregion = _parse_aoi_geojson(aoi_geojson)
    subregion = get_subregion(subregion_id)
    if aoi_subregion and subregion:
        raise HTTPException(
            status_code=400,
            detail="Choose either an ROI polygon or subregion_id.",
        )
    if aoi_subregion:
        return aoi_subregion
    return subregion


def _points_in_ring(lons: np.ndarray, lats: np.ndarray, ring: np.ndarray) -> np.ndarray:
    inside = np.zeros(lons.shape[0], dtype=bool)
    x = ring[:, 0]
    y = ring[:, 1]
    n = len(ring) - 1
    eps = 1e-12

    for i in range(n):
        xi = x[i]
        yi = y[i]
        xj = x[i + 1]
        yj = y[i + 1]
        intersects = ((yi > lats) != (yj > lats)) & (
            lons < (xj - xi) * (lats - yi) / ((yj - yi) + eps) + xi
        )
        inside ^= intersects
    return inside


def points_in_subregion(lons: np.ndarray, lats: np.ndarray, subregion: Dict[str, Any]) -> np.ndarray:
    if lons.size == 0:
        return np.zeros(0, dtype=bool)

    bounds = subregion["bounds"]
    bbox_mask = (
        (lons >= bounds["min_lon"])
        & (lons <= bounds["max_lon"])
        & (lats >= bounds["min_lat"])
        & (lats <= bounds["max_lat"])
    )
    if not bbox_mask.any():
        return bbox_mask

    final_mask = np.zeros(lons.shape[0], dtype=bool)
    candidate_idx = np.where(bbox_mask)[0]
    cand_lons = lons[candidate_idx]
    cand_lats = lats[candidate_idx]
    cand_inside = np.zeros(cand_lons.shape[0], dtype=bool)

    for polygon in subregion["polygons"]:
        poly_inside = _points_in_ring(cand_lons, cand_lats, polygon["outer"])
        if polygon["holes"]:
            hole_mask = np.zeros(cand_lons.shape[0], dtype=bool)
            for hole in polygon["holes"]:
                hole_mask |= _points_in_ring(cand_lons, cand_lats, hole)
            poly_inside &= ~hole_mask
        cand_inside |= poly_inside

    final_mask[candidate_idx] = cand_inside
    return final_mask


def _get_subregion_shapely_geometry(subregion: Dict[str, Any]):
    if shapely_shape is None:
        return None

    cached = subregion.get("_shapely_geometry")
    if cached is not None:
        return cached

    geometry = subregion.get("geometry")
    if not geometry:
        return None

    try:
        shapely_geometry = shapely_shape(geometry)
    except Exception:
        return None

    subregion["_shapely_geometry"] = shapely_geometry
    return shapely_geometry


def build_subregion_mask(df: pd.DataFrame, lat_col: str, lon_col: str, subregion: Dict[str, Any]) -> np.ndarray:
    """Build a row-level subregion mask using unique coordinates for speed."""
    if df.empty:
        return np.zeros(0, dtype=bool)

    lons = pd.to_numeric(df[lon_col], errors="coerce").to_numpy(dtype=np.float64, copy=False)
    lats = pd.to_numeric(df[lat_col], errors="coerce").to_numpy(dtype=np.float64, copy=False)
    finite = np.isfinite(lons) & np.isfinite(lats)
    if not finite.any():
        return np.zeros(df.shape[0], dtype=bool)
    if subregion.get("kind") == "bbox":
        bounds = subregion["bounds"]
        return (
            finite
            & (lons >= float(bounds["min_lon"]))
            & (lons <= float(bounds["max_lon"]))
            & (lats >= float(bounds["min_lat"]))
            & (lats <= float(bounds["max_lat"]))
        )

    coords = np.column_stack((lons[finite], lats[finite]))
    unique_coords, inverse = np.unique(coords, axis=0, return_inverse=True)
    shapely_geometry = _get_subregion_shapely_geometry(subregion)
    if shapely_geometry is not None and shapely_contains_xy is not None:
        inside_unique = np.asarray(
            shapely_contains_xy(shapely_geometry, unique_coords[:, 0], unique_coords[:, 1]),
            dtype=bool,
        )
    else:
        inside_unique = points_in_subregion(unique_coords[:, 0], unique_coords[:, 1], subregion)

    mask = np.zeros(df.shape[0], dtype=bool)
    mask[finite] = inside_unique[inverse]
    return mask


def filter_point_dataframe_by_subregion(
    df: pd.DataFrame,
    subregion: Optional[Dict[str, Any]],
    lat_col: str = "lat",
    lon_col: str = "lon",
) -> pd.DataFrame:
    """Return rows inside a subregion, using its bounds before exact polygon tests."""
    if subregion is None or df.empty or lat_col not in df.columns or lon_col not in df.columns:
        return df

    bounds = subregion.get("bounds") or {}
    lats = pd.to_numeric(df[lat_col], errors="coerce")
    lons = pd.to_numeric(df[lon_col], errors="coerce")
    bbox_mask = (
        lats.notna()
        & lons.notna()
        & (lats >= float(bounds.get("min_lat", -90.0)))
        & (lats <= float(bounds.get("max_lat", 90.0)))
        & (lons >= float(bounds.get("min_lon", -180.0)))
        & (lons <= float(bounds.get("max_lon", 180.0)))
    )
    if not bool(bbox_mask.any()):
        return df.iloc[0:0]

    candidate = df.loc[bbox_mask]
    exact_mask = build_subregion_mask(candidate, lat_col, lon_col, subregion)
    return candidate.loc[exact_mask]


def ensure_uploaded_nc_dirs() -> None:
    UPLOADED_NC_ROOT.mkdir(parents=True, exist_ok=True)
    UPLOADED_NC_FILES_DIR.mkdir(parents=True, exist_ok=True)


def build_uploaded_dataset_label(name: str) -> str:
    cleaned = name.strip()
    return f"NC Upload - {cleaned or 'Dataset'}"


def resolve_dataset_path(paths: List[Path]) -> Path:
    """Prefer an existing path that already has data files (parquet/geotiff), else first existing path."""
    for path in paths:
        if path.exists() and (list(path.glob("*.parquet")) or list(path.glob("*.tif")) or list(path.glob("*.tiff"))):
            return path
    for path in paths:
        if path.exists():
            return path
    return paths[0]


def _normalize_config(config: Dict[str, Any]) -> Dict[str, Any]:
    raw_paths = config.get("paths", [])
    paths = [Path(path) if not isinstance(path, Path) else path for path in raw_paths]
    return {
        "label": config.get("label", "Dataset"),
        "paths": paths,
        "source": config.get("source", "builtin"),
        "storage": config.get("storage", PARQUET_STORAGE),
        "file_pattern": config.get("file_pattern", "*.parquet"),
        "default_elevation": float(config.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION)),
        "map_max_points": int(config.get("map_max_points", GEOTIFF_DEFAULT_MAP_MAX_POINTS)),
        "interactive_sample_column": config.get("interactive_sample_column"),
        "hotspot_sample_column": config.get("hotspot_sample_column"),
        "map_exclude_zero_variables": tuple(config.get("map_exclude_zero_variables") or ()),
        "reference_date": config.get("reference_date"),
        "variable_columns": tuple(config.get("variable_columns") or ()),
        "feature_kind": config.get("feature_kind", "discharge_network"),
        "elevation_is_value": bool(config.get("elevation_is_value", False)),
    }


def rebuild_dataset_configs() -> None:
    DATASET_CONFIGS.clear()
    for dataset_id, config in BASE_DATASET_CONFIGS.items():
        DATASET_CONFIGS[dataset_id] = _normalize_config(config)

    uploaded_configs = list_uploaded_dataset_configs(UPLOADED_NC_MANIFEST)
    for dataset_id, config in uploaded_configs.items():
        DATASET_CONFIGS[dataset_id] = _normalize_config(config)


def init_dataset_state() -> None:
    rebuild_dataset_configs()
    DATASET_STATE.clear()
    for dataset_id, config in DATASET_CONFIGS.items():
        path = resolve_dataset_path(config["paths"])
        DATASET_STATE[dataset_id] = {
            "id": dataset_id,
            "label": config["label"],
            "source": config.get("source", "builtin"),
            "storage": config.get("storage", PARQUET_STORAGE),
            "file_pattern": config.get("file_pattern", "*.parquet"),
            "default_elevation": config.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION),
            "map_max_points": config.get("map_max_points", GEOTIFF_DEFAULT_MAP_MAX_POINTS),
            "interactive_sample_column": config.get("interactive_sample_column"),
            "hotspot_sample_column": config.get("hotspot_sample_column"),
            "map_exclude_zero_variables": config.get("map_exclude_zero_variables", ()),
            "reference_date": config.get("reference_date"),
            "variable_columns": config.get("variable_columns", ()),
            "feature_kind": config.get("feature_kind", "discharge_network"),
            "elevation_is_value": config.get("elevation_is_value", False),
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
            "band_map": {},
            "geotiff_profile": {},
        }


def count_files(path: Path, pattern: str) -> int:
    if not path.exists():
        return 0
    return len(list(path.glob(pattern)))


def get_datasets_summary() -> List[Dict]:
    summary = []
    for dataset_id, state in DATASET_STATE.items():
        path = state["path"]
        storage = state.get("storage", PARQUET_STORAGE)
        parquet_count = count_files(path, "*.parquet")
        geotiff_count = count_files(path, "*.tif") + count_files(path, "*.tiff")
        csv_count = count_files(path, "*.csv")
        ready = geotiff_count > 0 if storage == GEOTIFF_STORAGE else parquet_count > 0
        summary.append(
            {
                "id": dataset_id,
                "label": state["label"],
                "path": str(path),
                "storage": storage,
                "parquet_files": parquet_count,
                "geotiff_files": geotiff_count,
                "csv_files": csv_count,
                "ready": ready,
                "source": state.get("source", "builtin"),
            }
        )
    return summary


def _build_long_term_hotspot_summary(outcome_id: str) -> Dict[str, Any]:
    config = OUTCOME_CONFIGS[outcome_id]
    state = OUTCOME_STATE[outcome_id]
    ready = config["parquet"].exists()
    differences_ready = config["diff_parquet"].exists()
    return {
        "id": outcome_id,
        "label": config["label"],
        "description": config["description"],
        "dataset": config["dataset"],
        "ready": ready,
        "differences_ready": differences_ready,
        "parquet_path": str(config["parquet"]),
        "difference_parquet_path": str(config["diff_parquet"]),
        "metadata_path": str(config["meta"]),
        "variables": state.get("variables", []),
        "bands": state.get("bands", []),
        "comparisons": state.get("comparisons", []),
        "row_count": int(state.get("meta", {}).get("row_count", 0)) if state.get("meta") else 0,
        "difference_row_count": int(state.get("diff_meta", {}).get("row_count", 0)) if state.get("diff_meta") else 0,
    }


def get_outcomes_summary() -> List[Dict[str, Any]]:
    return [_build_long_term_hotspot_summary(outcome_id) for outcome_id in OUTCOME_CONFIGS]


def _load_long_term_hotspot_outcome(
    outcome_id: str = "long_term_hotspot", force_reload: bool = False
) -> Dict[str, Any]:
    config = OUTCOME_CONFIGS.get(outcome_id)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unknown outcome '{outcome_id}'")
    state = OUTCOME_STATE[outcome_id]
    parquet_path: Path = config["parquet"]
    meta_path: Path = config["meta"]
    diff_parquet_path: Path = config["diff_parquet"]
    diff_meta_path: Path = config["diff_meta"]
    if not parquet_path.exists():
        raise HTTPException(
            status_code=404,
            detail=(
                f"{config['label']} output parquet not found. "
                f"Run {config['generation_script']}"
            ),
        )

    parquet_mtime = parquet_path.stat().st_mtime
    meta_mtime = meta_path.stat().st_mtime if meta_path.exists() else None
    diff_parquet_mtime = diff_parquet_path.stat().st_mtime if diff_parquet_path.exists() else None
    diff_meta_mtime = diff_meta_path.stat().st_mtime if diff_meta_path.exists() else None

    if (
        state["loaded"]
        and not force_reload
        and state.get("parquet_mtime") == parquet_mtime
        and state.get("meta_mtime") == meta_mtime
        and state.get("diff_parquet_mtime") == diff_parquet_mtime
        and state.get("diff_meta_mtime") == diff_meta_mtime
    ):
        return state

    df = pd.read_parquet(parquet_path)
    required_columns = {
        "band_id",
        "band_label",
        "start_year",
        "end_year",
        "variable",
        "lat",
        "lon",
        "elev",
        "value",
        "sample_count",
    }
    missing = required_columns - set(df.columns)
    if missing:
        raise HTTPException(
            status_code=500,
            detail=(
                "Invalid long-term hotspot output schema. "
                f"Missing columns: {sorted(missing)}"
            ),
        )

    for col in ("lat", "lon", "elev", "value"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["sample_count"] = pd.to_numeric(df["sample_count"], errors="coerce").fillna(0).astype(int)
    df["start_year"] = pd.to_numeric(df["start_year"], errors="coerce").fillna(0).astype(int)
    df["end_year"] = pd.to_numeric(df["end_year"], errors="coerce").fillna(0).astype(int)

    df = df.dropna(subset=["lat", "lon", "value"]).copy()

    meta: Dict[str, Any] = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Could not parse long-term hotspot metadata JSON: %s", exc)
            meta = {}

    variables = sorted(meta.get("variables", [])) if meta.get("variables") else sorted(df["variable"].dropna().astype(str).unique().tolist())
    if meta.get("bands"):
        bands = meta["bands"]
    else:
        band_rows = (
            df[["band_id", "band_label", "start_year", "end_year"]]
            .drop_duplicates()
            .sort_values(["start_year", "end_year", "band_id"])
        )
        bands = [
            {
                "id": str(row.band_id),
                "label": str(row.band_label),
                "start_year": int(row.start_year),
                "end_year": int(row.end_year),
            }
            for row in band_rows.itertuples(index=False)
        ]

    diff_df = pd.DataFrame()
    diff_meta: Dict[str, Any] = {}
    comparisons: List[Dict[str, Any]] = []
    if diff_parquet_path.exists():
        try:
            diff_df = pd.read_parquet(diff_parquet_path)
            required_diff_columns = {
                "id",
                "label",
                "earlier_band_id",
                "earlier_band_label",
                "later_band_id",
                "later_band_label",
                "variable",
                "lat",
                "lon",
                "elev",
                "earlier_value",
                "later_value",
                "change_value",
                "abs_change_value",
                "earlier_sample_count",
                "later_sample_count",
            }
            missing_diff = required_diff_columns - set(diff_df.columns)
            if missing_diff:
                logger.warning(
                    "Ignoring invalid long-term hotspot difference parquet. Missing columns: %s",
                    sorted(missing_diff),
                )
                diff_df = pd.DataFrame()
            else:
                for col in (
                    "lat",
                    "lon",
                    "elev",
                    "earlier_value",
                    "later_value",
                    "change_value",
                    "abs_change_value",
                    "pct_change_value",
                ):
                    if col in diff_df.columns:
                        diff_df[col] = pd.to_numeric(diff_df[col], errors="coerce")
                for col in ("earlier_sample_count", "later_sample_count"):
                    diff_df[col] = pd.to_numeric(diff_df[col], errors="coerce").fillna(0).astype(int)
                diff_df = diff_df.dropna(subset=["lat", "lon", "change_value"]).copy()
        except Exception as exc:
            logger.warning("Could not load long-term hotspot difference parquet: %s", exc)
            diff_df = pd.DataFrame()

    if diff_meta_path.exists():
        try:
            diff_meta = json.loads(diff_meta_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Could not parse long-term hotspot difference metadata JSON: %s", exc)
            diff_meta = {}

    if diff_meta.get("comparisons"):
        comparisons = diff_meta["comparisons"]
    elif not diff_df.empty:
        comparison_rows = (
            diff_df[
                [
                    "id",
                    "label",
                    "earlier_band_id",
                    "earlier_band_label",
                    "later_band_id",
                    "later_band_label",
                ]
            ]
            .drop_duplicates()
            .sort_values(["id"])
        )
        comparisons = [
            {
                "id": str(row.id),
                "label": str(row.label),
                "earlier_band_id": str(row.earlier_band_id),
                "earlier_band_label": str(row.earlier_band_label),
                "later_band_id": str(row.later_band_id),
                "later_band_label": str(row.later_band_label),
            }
            for row in comparison_rows.itertuples(index=False)
        ]

    state.update(
        {
            "loaded": True,
            "parquet_mtime": parquet_mtime,
            "meta_mtime": meta_mtime,
            "diff_parquet_mtime": diff_parquet_mtime,
            "diff_meta_mtime": diff_meta_mtime,
            "df": df,
            "diff_df": diff_df,
            "meta": meta,
            "diff_meta": diff_meta,
            "variables": variables,
            "bands": bands,
            "comparisons": comparisons,
        }
    )
    return state


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
    preferred = [
        "temperature_C",
        "temp_mean_C",
        "temp_C",
        "temperature",
        "precipitation_mm",
        "precip_mm_day",
        "Snow_Albedo_Daily_Tile",
        "NDSI_Snow_Cover",
    ]
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


def is_geotiff_dataset(state: Dict[str, Any]) -> bool:
    return state.get("storage") == GEOTIFF_STORAGE


def is_geoparquet_dataset(state: Dict[str, Any]) -> bool:
    return state.get("storage") == GEOPARQUET_STORAGE


def ensure_geopandas_available() -> None:
    if gpd is None:
        raise HTTPException(
            status_code=500,
            detail="GeoPandas is required to read GeoParquet datasets. Install backend dependency 'geopandas'.",
        )


def get_geoparquet_files(state: Dict[str, Any]) -> List[Path]:
    path = state["path"]
    if not path.exists():
        return []
    return sorted(path.glob(state.get("file_pattern") or "*.parquet"))


def parse_and_normalize_date(date_str: str) -> str:
    """Parse date from YYYY-MM-DD or Indian DD-MM-YYYY (or DD/MM/YYYY) format and return canonical YYYY-MM-DD."""
    if not date_str:
        raise ValueError("Empty date string")
    raw = str(date_str).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Invalid date format: '{date_str}'. Use DD-MM-YYYY or YYYY-MM-DD.")


def format_date_indian(date_val: Any) -> Optional[str]:
    """Format a date or YYYY-MM-DD string into Indian date format DD-MM-YYYY."""
    if not date_val:
        return None
    if isinstance(date_val, (datetime, date)):
        return date_val.strftime("%d-%m-%Y")
    text = str(date_val).strip()
    if len(text) == 10 and text[2] == "-" and text[5] == "-":
        return text
    try:
        dt = datetime.strptime(text[:10], "%Y-%m-%d")
        return dt.strftime("%d-%m-%Y")
    except Exception:
        return text


def parse_geoparquet_date_from_path(
    file_path: Path,
    reference_date: Optional[str] = None,
) -> Optional[str]:
    if reference_date:
        try:
            return datetime.strptime(reference_date, "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            logger.warning("Invalid GeoParquet reference_date '%s' for %s", reference_date, file_path)
            return None
    match = DISCHARGE_DATE_PATTERN.match(file_path.stem)
    if not match:
        years = extract_years_from_filename(file_path)
        if not years:
            return None
        return f"{years[0]}-01-01"
    year, month, day = match.groups()
    try:
        return datetime(int(year), int(month), int(day)).strftime("%Y-%m-%d")
    except ValueError:
        return None


def geoparquet_file_in_year_range(
    file_path: Path,
    year_start: Optional[int],
    year_end: Optional[int],
    reference_date: Optional[str] = None,
) -> bool:
    date_str = parse_geoparquet_date_from_path(file_path, reference_date)
    if not date_str:
        return False
    year = int(date_str[:4])
    if year_start is not None and year < year_start:
        return False
    if year_end is not None and year > year_end:
        return False
    return True


def select_geoparquet_files_for_year_range(
    geoparquet_files: List[Path],
    year_start: Optional[int],
    year_end: Optional[int],
    reference_date: Optional[str] = None,
) -> List[Path]:
    if year_start is None and year_end is None:
        return [
            file_path
            for file_path in geoparquet_files
            if parse_geoparquet_date_from_path(file_path, reference_date)
        ]
    return [
        file_path
        for file_path in geoparquet_files
        if geoparquet_file_in_year_range(file_path, year_start, year_end, reference_date)
    ]


def load_geoparquet_schema(state: Dict[str, Any], geoparquet_files: List[Path]) -> None:
    if not geoparquet_files:
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        return

    try:
        columns = list(pq.ParquetFile(geoparquet_files[0]).schema.names)
    except Exception:
        ensure_geopandas_available()
        columns = list(gpd.read_parquet(geoparquet_files[0]).columns)  # type: ignore[union-attr]

    # GeoParquet writers may expose covering bbox helper columns; keep them out
    # of the scientific variable list shown in the UI.
    helper_columns = {"geometry", "xmin", "ymin", "xmax", "ymax"}
    configured_variables = list(state.get("variable_columns") or ())
    if configured_variables:
        variables = [column for column in configured_variables if column in columns]
    else:
        variables = [
            column
            for column in columns
            if column not in helper_columns and not column.lower().startswith("bbox")
        ]
    if DISCHARGE_VALUE_COL in variables:
        variables = [DISCHARGE_VALUE_COL] + [column for column in variables if column != DISCHARGE_VALUE_COL]

    state["date_col"] = "date"
    state["lat_col"] = "latitude"
    state["lon_col"] = "longitude"
    state["elev_col"] = "elevation_m"
    state["variables"] = variables
    state["default_variable"] = DISCHARGE_VALUE_COL if DISCHARGE_VALUE_COL in variables else choose_default_variable(variables)
    state["all_columns"] = ["date", "latitude", "longitude", "elevation_m"] + variables + ["geometry"]


def load_geoparquet_dataset_index(
    state: Dict[str, Any],
    force_reload: bool = False,
    year_start: Optional[int] = None,
    year_end: Optional[int] = None,
) -> None:
    cache_key = build_index_cache_key(year_start, year_end)
    if state["loaded"] and not force_reload and state.get("active_index_key") == cache_key:
        return

    if force_reload:
        state["index_cache"] = {}

    geoparquet_files = get_geoparquet_files(state)
    if not geoparquet_files:
        state["loaded"] = False
        state["active_index_key"] = None
        state["active_year_start"] = None
        state["active_year_end"] = None
        state["date_index"] = {}
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        state["elevation_range"] = None
        logger.warning("No GeoParquet files found for dataset '%s' in %s", state["id"], state["path"])
        return

    if force_reload or not state["all_columns"]:
        load_geoparquet_schema(state, geoparquet_files)

    cached = state["index_cache"].get(cache_key)
    if cached and not force_reload:
        state["date_index"] = cached["date_index"]
        state["loaded"] = True
        state["active_index_key"] = cache_key
        state["active_year_start"] = year_start
        state["active_year_end"] = year_end
        return

    reference_date = state.get("reference_date")
    candidate_files = select_geoparquet_files_for_year_range(
        geoparquet_files,
        year_start,
        year_end,
        reference_date,
    )
    year_tag = f"{year_start or '*'}-{year_end or '*'}"
    logger.info(
        f"Loading index for GeoParquet dataset '{state['id']}' from {state['path']} "
        f"(years {year_tag}, files {len(candidate_files)}/{len(geoparquet_files)})"
    )

    date_index: Dict[str, List[str]] = {}
    for file_path in candidate_files:
        date_str = parse_geoparquet_date_from_path(file_path, reference_date)
        if not date_str:
            continue
        date_index.setdefault(date_str, []).append(str(file_path))
        logger.info(f"[{state['id']}] Indexed {file_path.name}: {date_str}")

    state["date_index"] = date_index
    state["loaded"] = True
    state["active_index_key"] = cache_key
    state["active_year_start"] = year_start
    state["active_year_end"] = year_end
    if state.get("elevation_is_value"):
        state["elevation_range"] = None
    else:
        state["elevation_range"] = {
            "min": float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION)),
            "max": float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION)),
        }
    state["index_cache"][cache_key] = {"date_index": date_index}
    while len(state["index_cache"]) > 6:
        oldest = next(iter(state["index_cache"]))
        del state["index_cache"][oldest]

    logger.info(f"[{state['id']}] Total indexed dates ({year_tag}): {len(date_index)}")


def ensure_rasterio_available() -> None:
    if rasterio is None:
        raise HTTPException(
            status_code=500,
            detail="Rasterio is required to read GeoTIFF datasets. Install backend dependency 'rasterio'.",
        )


def get_geotiff_files(state: Dict[str, Any]) -> List[Path]:
    path = state["path"]
    if not path.exists():
        return []
    pattern = state.get("file_pattern") or "*.tif"
    files = sorted(path.glob(pattern))
    if pattern.lower().endswith(".tif"):
        files.extend(sorted(path.glob(pattern[:-4] + ".tiff")))
    # Preserve ordering while removing duplicates.
    return list(dict.fromkeys(files))


def parse_geotiff_date_from_path(file_path: Path) -> Optional[str]:
    match = GEOTIFF_DATE_PATTERN.match(file_path.stem)
    if not match:
        years = extract_years_from_filename(file_path)
        if not years:
            return None
        return f"{years[0]}-01-01"

    year = int(match.group(1))
    month = int(match.group(2))
    if month < 1 or month > 12:
        return None
    return datetime(year, month, 1).strftime("%Y-%m-%d")


def geotiff_file_in_year_range(
    file_path: Path,
    year_start: Optional[int],
    year_end: Optional[int],
) -> bool:
    date_str = parse_geotiff_date_from_path(file_path)
    if not date_str:
        return False
    year = int(date_str[:4])
    if year_start is not None and year < year_start:
        return False
    if year_end is not None and year > year_end:
        return False
    return True


def select_geotiff_files_for_year_range(
    geotiff_files: List[Path],
    year_start: Optional[int],
    year_end: Optional[int],
) -> List[Path]:
    if year_start is None and year_end is None:
        return [file_path for file_path in geotiff_files if parse_geotiff_date_from_path(file_path)]
    return [
        file_path
        for file_path in geotiff_files
        if geotiff_file_in_year_range(file_path, year_start, year_end)
    ]


def sanitize_geotiff_variable_name(raw_name: Optional[str], band_index: int, used_names: set[str]) -> str:
    cleaned = (raw_name or "").strip() or f"band_{band_index}"
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", cleaned).strip("_") or f"band_{band_index}"
    if cleaned[0].isdigit():
        cleaned = f"band_{band_index}_{cleaned}"

    candidate = cleaned
    suffix = 2
    while candidate in used_names:
        candidate = f"{cleaned}_{suffix}"
        suffix += 1
    used_names.add(candidate)
    return candidate


def load_geotiff_schema(state: Dict[str, Any], geotiff_files: List[Path]) -> None:
    if not geotiff_files:
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        state["band_map"] = {}
        state["geotiff_profile"] = {}
        return

    ensure_rasterio_available()

    sample_file = geotiff_files[0]
    try:
        with rasterio.open(sample_file) as src:  # type: ignore[union-attr]
            descriptions = list(src.descriptions or [])
            used_names: set[str] = set()
            variables: List[str] = []
            band_map: Dict[str, int] = {}
            for band_index in range(1, src.count + 1):
                raw_name = descriptions[band_index - 1] if band_index - 1 < len(descriptions) else None
                variable_name = sanitize_geotiff_variable_name(raw_name, band_index, used_names)
                variables.append(variable_name)
                band_map[variable_name] = band_index

            bounds = src.bounds
            crs_text = src.crs.to_string() if src.crs else None
            state["geotiff_profile"] = {
                "sample_file": sample_file.name,
                "width": int(src.width),
                "height": int(src.height),
                "band_count": int(src.count),
                "crs": crs_text,
                "bounds": {
                    "min_lon": float(bounds.left),
                    "min_lat": float(bounds.bottom),
                    "max_lon": float(bounds.right),
                    "max_lat": float(bounds.top),
                },
                "dtype": str(src.dtypes[0]) if src.dtypes else None,
            }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read GeoTIFF schema from {sample_file.name}: {exc}",
        ) from exc

    state["date_col"] = GEOTIFF_DATE_COL
    state["lat_col"] = GEOTIFF_LAT_COL
    state["lon_col"] = GEOTIFF_LON_COL
    state["elev_col"] = GEOTIFF_ELEV_COL
    state["variables"] = variables
    state["default_variable"] = choose_default_variable(variables)
    state["all_columns"] = [GEOTIFF_DATE_COL, GEOTIFF_LAT_COL, GEOTIFF_LON_COL, GEOTIFF_ELEV_COL] + variables
    state["band_map"] = band_map


def load_geotiff_dataset_index(
    state: Dict[str, Any],
    force_reload: bool = False,
    year_start: Optional[int] = None,
    year_end: Optional[int] = None,
) -> None:
    cache_key = build_index_cache_key(year_start, year_end)
    if state["loaded"] and not force_reload and state.get("active_index_key") == cache_key:
        return

    if force_reload:
        state["index_cache"] = {}

    geotiff_files = get_geotiff_files(state)
    if not geotiff_files:
        state["loaded"] = False
        state["active_index_key"] = None
        state["active_year_start"] = None
        state["active_year_end"] = None
        state["date_index"] = {}
        state["variables"] = []
        state["all_columns"] = []
        state["default_variable"] = None
        state["band_map"] = {}
        state["geotiff_profile"] = {}
        state["elevation_range"] = {
            "min": float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION)),
            "max": float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION)),
        }
        logger.warning("No GeoTIFF files found for dataset '%s' in %s", state["id"], state["path"])
        return

    if force_reload or not state["all_columns"]:
        load_geotiff_schema(state, geotiff_files)

    cached = state["index_cache"].get(cache_key)
    if cached and not force_reload:
        state["date_index"] = cached["date_index"]
        state["loaded"] = True
        state["active_index_key"] = cache_key
        state["active_year_start"] = year_start
        state["active_year_end"] = year_end
        return

    candidate_files = select_geotiff_files_for_year_range(geotiff_files, year_start, year_end)
    year_tag = f"{year_start or '*'}-{year_end or '*'}"
    logger.info(
        "Loading GeoTIFF index for dataset '%s' from %s (years %s, files %d/%d)",
        state["id"],
        state["path"],
        year_tag,
        len(candidate_files),
        len(geotiff_files),
    )

    date_index: Dict[str, List[str]] = {}
    for file_path in candidate_files:
        date_str = parse_geotiff_date_from_path(file_path)
        if not date_str:
            logger.warning("[%s] Skipping GeoTIFF with unknown date: %s", state["id"], file_path.name)
            continue
        date_index.setdefault(date_str, []).append(str(file_path))

    state["date_index"] = date_index
    state["loaded"] = True
    state["active_index_key"] = cache_key
    state["active_year_start"] = year_start
    state["active_year_end"] = year_end
    default_elevation = float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION))
    state["elevation_range"] = {"min": default_elevation, "max": default_elevation}
    state["index_cache"][cache_key] = {"date_index": date_index}
    while len(state["index_cache"]) > 6:
        oldest = next(iter(state["index_cache"]))
        del state["index_cache"][oldest]

    logger.info("[%s] Total indexed GeoTIFF dates (%s): %d", state["id"], year_tag, len(date_index))


def geotiff_elevation_allowed(state: Dict[str, Any], elev_min: float, elev_max: float) -> bool:
    default_elevation = float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION))
    return float(elev_min) <= default_elevation <= float(elev_max)


def read_geotiff_band(
    file_path: str,
    band_index: int,
    bounds: Optional[Dict[str, float]] = None,
) -> Tuple[np.ndarray, np.ndarray, Any]:
    ensure_rasterio_available()
    with rasterio.open(file_path) as src:  # type: ignore[union-attr]
        if band_index < 1 or band_index > src.count:
            raise ValueError(f"Band {band_index} is outside GeoTIFF band range 1-{src.count}")
        window = None
        transform = src.transform
        if bounds:
            try:
                requested_window = rasterio.windows.from_bounds(  # type: ignore[union-attr]
                    float(bounds["min_lon"]),
                    float(bounds["min_lat"]),
                    float(bounds["max_lon"]),
                    float(bounds["max_lat"]),
                    transform=src.transform,
                )
                full_window = rasterio.windows.Window(0, 0, src.width, src.height)  # type: ignore[union-attr]
                window = requested_window.intersection(full_window).round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    return np.empty((0, 0)), np.zeros((0, 0), dtype=bool), transform
                transform = src.window_transform(window)
            except Exception as exc:
                logger.debug("Unable to create GeoTIFF window for %s: %s", file_path, exc)
                window = None

        band = src.read(band_index, window=window, masked=True)
        if np.ma.isMaskedArray(band):
            values = np.asarray(band.filled(np.nan), dtype=np.float64)
            valid_mask = ~np.ma.getmaskarray(band)
        else:
            values = np.asarray(band, dtype=np.float64)
            valid_mask = np.ones(values.shape, dtype=bool)
        valid_mask &= np.isfinite(values)
        return values, valid_mask, transform


def geotiff_pixel_coordinates(transform: Any, rows: np.ndarray, cols: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    col_centers = cols.astype(np.float64, copy=False) + 0.5
    row_centers = rows.astype(np.float64, copy=False) + 0.5
    lons = transform.c + transform.a * col_centers + transform.b * row_centers
    lats = transform.f + transform.d * col_centers + transform.e * row_centers
    return lats, lons


def build_subregion_mask_for_points(
    lats: np.ndarray,
    lons: np.ndarray,
    subregion: Dict[str, Any],
) -> np.ndarray:
    if lats.size == 0:
        return np.zeros(0, dtype=bool)

    finite = np.isfinite(lats) & np.isfinite(lons)
    if not finite.any():
        return np.zeros(lats.shape[0], dtype=bool)

    bounds = subregion["bounds"]
    bbox_mask = (
        finite
        & (lons >= float(bounds["min_lon"]))
        & (lons <= float(bounds["max_lon"]))
        & (lats >= float(bounds["min_lat"]))
        & (lats <= float(bounds["max_lat"]))
    )
    if not bbox_mask.any():
        return bbox_mask
    if subregion.get("kind") == "bbox":
        return bbox_mask

    final_mask = np.zeros(lats.shape[0], dtype=bool)
    candidate_idx = np.where(bbox_mask)[0]
    shapely_geometry = _get_subregion_shapely_geometry(subregion)
    if shapely_geometry is not None and shapely_contains_xy is not None:
        final_mask[candidate_idx] = np.asarray(
            shapely_contains_xy(shapely_geometry, lons[candidate_idx], lats[candidate_idx]),
            dtype=bool,
        )
    else:
        final_mask[candidate_idx] = points_in_subregion(
            lons[candidate_idx],
            lats[candidate_idx],
            subregion,
        )
    return final_mask


def get_geotiff_band_index(state: Dict[str, Any], variable: str) -> int:
    band_map = state.get("band_map") or {}
    band_index = band_map.get(variable)
    if not band_index:
        raise HTTPException(status_code=400, detail=f"Variable '{variable}' is not mapped to a GeoTIFF band")
    return int(band_index)


def query_geotiff_data(
    state: Dict[str, Any],
    query_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
) -> List[Dict]:
    if query_date not in state["date_index"] or not geotiff_elevation_allowed(state, elev_min, elev_max):
        return []

    band_index = get_geotiff_band_index(state, variable)
    default_elevation = float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION))
    max_points = max(1000, int(state.get("map_max_points", GEOTIFF_DEFAULT_MAP_MAX_POINTS)))
    results: List[Dict] = []

    for file_path in state["date_index"][query_date]:
        try:
            values, valid_mask, transform = read_geotiff_band(
                file_path,
                band_index,
                bounds=subregion["bounds"] if subregion else None,
            )
            rows, cols = np.nonzero(valid_mask)
            if rows.size == 0:
                continue
            point_values = values[rows, cols]
            lats, lons = geotiff_pixel_coordinates(transform, rows, cols)
            if subregion:
                mask = build_subregion_mask_for_points(lats, lons, subregion)
                if not mask.any():
                    continue
                point_values = point_values[mask]
                lats = lats[mask]
                lons = lons[mask]

            if point_values.size > max_points:
                step = int(np.ceil(point_values.size / max_points))
                keep_idx = np.arange(0, point_values.size, step, dtype=np.int64)[:max_points]
                point_values = point_values[keep_idx]
                lats = lats[keep_idx]
                lons = lons[keep_idx]

            results.extend(
                {
                    "lat": float(lat),
                    "lon": float(lon),
                    "elev": default_elevation,
                    "value": float(value),
                }
                for lat, lon, value in zip(lats, lons, point_values)
            )
        except Exception as exc:
            logger.error("[%s] Error querying GeoTIFF %s: %s", state["id"], file_path, exc)

    return results


def calculate_geotiff_basin_mean(
    state: Dict[str, Any],
    start_date: str,
    end_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
    region_bounds: Optional[Dict[str, float]] = None,
) -> List[Dict]:
    if not geotiff_elevation_allowed(state, elev_min, elev_max):
        return []

    dates = sorted([d for d in state["date_index"].keys() if start_date <= d <= end_date])
    if not dates:
        return []

    band_index = get_geotiff_band_index(state, variable)
    results: List[Dict] = []
    for date_str in dates:
        value_sum = 0.0
        value_count = 0
        for file_path in state["date_index"][date_str]:
            try:
                read_bounds = region_bounds or (subregion["bounds"] if subregion else None)
                values, valid_mask, transform = read_geotiff_band(
                    file_path,
                    band_index,
                    bounds=read_bounds,
                )
                if region_bounds or subregion:
                    rows, cols = np.nonzero(valid_mask)
                    if rows.size == 0:
                        continue
                    point_values = values[rows, cols]
                    lats, lons = geotiff_pixel_coordinates(transform, rows, cols)
                    mask = np.ones(point_values.shape, dtype=bool)
                    if region_bounds:
                        mask &= (
                            (lats >= float(region_bounds["min_lat"]))
                            & (lats <= float(region_bounds["max_lat"]))
                            & (lons >= float(region_bounds["min_lon"]))
                            & (lons <= float(region_bounds["max_lon"]))
                        )
                    if subregion and mask.any():
                        mask &= build_subregion_mask_for_points(lats, lons, subregion)
                    if not mask.any():
                        continue
                    point_values = point_values[mask]
                else:
                    point_values = values[valid_mask]

                if point_values.size == 0:
                    continue
                value_sum += float(np.nansum(point_values))
                value_count += int(np.isfinite(point_values).sum())
            except Exception as exc:
                logger.error("[%s] Error in GeoTIFF basin mean for %s: %s", state["id"], file_path, exc)

        if value_count > 0:
            results.append(
                {
                    "date": date_str,
                    "mean_value": value_sum / value_count,
                    "pixel_count": value_count,
                }
            )

    return results


def empty_hotspot_result_for_dataset(
    state: Dict[str, Any],
    year_start: int,
    year_end: int,
    min_years: int,
) -> Dict[str, Any]:
    return {
        "summary": {
            "points_analyzed": 0,
            "hotspots_identified": 0,
            "year_start": year_start,
            "year_end": year_end,
            "min_years": min_years,
            "mean_strength": None,
            "max_strength": None,
            "strength_percentiles": {"p70": None, "p85": None, "p95": None},
            "note": f"Trend hotspot analysis is not enabled for GeoTIFF-backed dataset '{state['id']}'.",
        },
        "data": [],
        "top_hotspots": [],
    }


def get_geotiff_stats_payload(
    state: Dict[str, Any],
    year_start: Optional[int],
    year_end: Optional[int],
) -> Dict[str, Any]:
    geotiff_files = get_geotiff_files(state)
    if not geotiff_files:
        raise HTTPException(status_code=404, detail=f"No GeoTIFF files found for dataset '{state['id']}'")

    filtered_files = select_geotiff_files_for_year_range(geotiff_files, year_start, year_end)
    total_size = sum(file_path.stat().st_size for file_path in filtered_files)
    sample_file = filtered_files[0] if filtered_files else geotiff_files[0]
    band_index = get_geotiff_band_index(state, state["default_variable"] or state["variables"][0])
    values, valid_mask, _ = read_geotiff_band(str(sample_file), band_index)

    return {
        "dataset": state["id"],
        "dataset_label": state["label"],
        "dataset_path": str(state["path"]),
        "storage": GEOTIFF_STORAGE,
        "total_files": len(filtered_files),
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "total_dates": len(state["date_index"]),
        "year_start": year_start,
        "year_end": year_end,
        "variables": state["variables"],
        "geotiff_profile": state.get("geotiff_profile", {}),
        "sample_stats": {
            "columns": state["all_columns"],
            "sample_file": sample_file.name,
            "sample_records": int(valid_mask.sum()),
            "sample_min": float(np.nanmin(values[valid_mask])) if valid_mask.any() else None,
            "sample_max": float(np.nanmax(values[valid_mask])) if valid_mask.any() else None,
        },
    }


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
    if is_geotiff_dataset(state):
        default_elevation = float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION))
        state["elevation_range"] = {"min": default_elevation, "max": default_elevation}
        return default_elevation, default_elevation

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
    if is_geotiff_dataset(state):
        load_geotiff_dataset_index(
            state,
            force_reload=force_reload,
            year_start=year_start,
            year_end=year_end,
        )
        return
    if is_geoparquet_dataset(state):
        load_geoparquet_dataset_index(
            state,
            force_reload=force_reload,
            year_start=year_start,
            year_end=year_end,
        )
        return

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
            # Reduce millions of repeated grid-row dates to the few hundred
            # unique values in Arrow before crossing into pandas.
            date_table = pq.read_table(file_path, columns=[date_col])
            unique_date_values = pc.unique(date_table.column(date_col).combine_chunks()).to_pylist()
            parsed_dates = parse_datetime_series(
                pd.Series(unique_date_values),
                f"{file_path.name}:{date_col}",
            )

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
        storage = state.get("storage", PARQUET_STORAGE)
        if storage == GEOTIFF_STORAGE:
            expected_files = "GeoTIFF files"
            conversion_hint = f"Place MOD10A1 .tif/.tiff files in {state['path']}."
        elif storage == GEOPARQUET_STORAGE:
            expected_files = "GeoParquet files"
            conversion_hint = f"Place the configured GeoParquet files in {state['path']}."
        else:
            expected_files = "parquet files"
            conversion_hint = f"Convert CSV files first in {state['path']}."
        raise HTTPException(
            status_code=404,
            detail=(
                f"No {expected_files} found for dataset '{state['id']}'. "
                f"{conversion_hint}"
            ),
        )
    return state


def snapshot_dataset_state(state: Dict) -> Dict:
    """Freeze the active index before running a query outside the event loop."""
    snapshot = dict(state)
    snapshot["date_index"] = dict(state.get("date_index") or {})
    return snapshot


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
        # pandas 4+ emits a deprecation warning from pyarrow internals for BlockManager.
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="Passing a BlockManager to DataFrame is deprecated.*",
            )
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


def _json_safe_scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value) if np.isfinite(value) else None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    return value


def _read_geoparquet_frame(
    file_path: str,
    variable: str,
    state: Dict[str, Any],
    elev_min: Optional[float] = None,
    elev_max: Optional[float] = None,
) -> Any:
    ensure_geopandas_available()
    frame = gpd.read_parquet(file_path, columns=[variable, "geometry"])  # type: ignore[union-attr]
    if frame.empty:
        return frame
    frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty].copy()
    if frame.empty:
        return frame
    if frame.crs is not None:
        try:
            epsg = frame.crs.to_epsg()
        except Exception:
            epsg = None
        if epsg != 4326:
            frame = frame.to_crs("EPSG:4326")
    if state.get("elevation_is_value"):
        values = pd.to_numeric(frame[variable], errors="coerce")
        valid = values.notna()
        if elev_min is not None:
            valid &= values >= float(elev_min)
        if elev_max is not None:
            valid &= values <= float(elev_max)
        frame = frame.loc[valid].copy()
    return frame


def _filter_discharge_by_subregion(frame: Any, subregion: Optional[Dict[str, Any]]) -> Any:
    if not subregion or frame.empty:
        return frame

    bounds = subregion["bounds"]
    candidate = frame.cx[
        float(bounds["min_lon"]):float(bounds["max_lon"]),
        float(bounds["min_lat"]):float(bounds["max_lat"]),
    ]
    if candidate.empty:
        return candidate

    shapely_geometry = _get_subregion_shapely_geometry(subregion)
    if shapely_geometry is None:
        return candidate

    try:
        return candidate[candidate.geometry.intersects(shapely_geometry)].copy()
    except Exception:
        centroids = candidate.geometry.representative_point()
        mask = points_in_subregion(
            centroids.x.to_numpy(dtype=np.float64),
            centroids.y.to_numpy(dtype=np.float64),
            subregion,
        )
        return candidate.loc[mask].copy()


def _filter_discharge_by_bbox(
    frame: Any,
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
) -> Any:
    if frame.empty:
        return frame
    return frame.cx[float(min_lon):float(max_lon), float(min_lat):float(max_lat)]


def _geoparquet_frame_to_records(
    frame: Any,
    *,
    date: str,
    variable: str,
    state: Dict[str, Any],
) -> List[Dict[str, Any]]:
    if frame.empty:
        return []

    max_points = max(1, int(state.get("map_max_points", GEOTIFF_DEFAULT_MAP_MAX_POINTS)))
    if len(frame) > max_points:
        sample_positions = np.linspace(0, len(frame) - 1, num=max_points, dtype=np.int64)
        frame = frame.iloc[sample_positions].copy()

    # Render GeoParquet geometries at representative points. This keeps the
    # browser response bounded for both polygon networks and DEM point grids.
    centroids = frame.geometry.representative_point()
    feature_kind = str(state.get("feature_kind") or "geoparquet")
    raw_values = frame[variable].to_numpy(copy=False)
    longitudes = centroids.x.to_numpy(dtype=np.float64, copy=False)
    latitudes = centroids.y.to_numpy(dtype=np.float64, copy=False)
    default_elevation = float(state.get("default_elevation", GEOTIFF_DEFAULT_ELEVATION))
    elevation_is_value = bool(state.get("elevation_is_value"))

    records: List[Dict[str, Any]] = []
    for raw_value, longitude, latitude in zip(raw_values, longitudes, latitudes):
        value = _json_safe_scalar(raw_value)
        if value is not None and np.isfinite(longitude) and np.isfinite(latitude):
            records.append({
                "dataset": state["id"],
                "kind": feature_kind,
                "date": date,
                "variable": variable,
                "value": float(value),
                variable: _json_safe_scalar(raw_value),
                "lat": float(latitude),
                "lon": float(longitude),
                "elev": float(value) if elevation_is_value else default_elevation,
            })
    return records


def query_geoparquet_data(
    state: Dict[str, Any],
    query_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    if query_date not in state["date_index"]:
        return []

    results: List[Dict[str, Any]] = []
    for file_path in state["date_index"][query_date]:
        try:
            frame = _read_geoparquet_frame(
                file_path,
                variable,
                state,
                elev_min=elev_min,
                elev_max=elev_max,
            )
            frame = _filter_discharge_by_subregion(frame, subregion)
            results.extend(
                _geoparquet_frame_to_records(
                    frame,
                    date=query_date,
                    variable=variable,
                    state=state,
                )
            )
        except Exception as exc:
            logger.error(f"[{state['id']}] Error querying GeoParquet {file_path}: {exc}")
    map_max_points = max(1, int(state.get("map_max_points", GEOTIFF_DEFAULT_MAP_MAX_POINTS)))
    if len(results) > map_max_points:
        sample_positions = np.linspace(0, len(results) - 1, num=map_max_points, dtype=np.int64)
        results = [results[position] for position in sample_positions]
    return results


def calculate_geoparquet_basin_mean(
    state: Dict[str, Any],
    start_date: str,
    end_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
    region_bounds: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    dates = sorted([d for d in state["date_index"].keys() if start_date <= d <= end_date])
    results: List[Dict[str, Any]] = []
    for date_key in dates:
        frames = []
        for file_path in state["date_index"][date_key]:
            try:
                frame = _read_geoparquet_frame(
                    file_path,
                    variable,
                    state,
                    elev_min=elev_min,
                    elev_max=elev_max,
                )
                if region_bounds:
                    frame = _filter_discharge_by_bbox(
                        frame,
                        region_bounds["min_lat"],
                        region_bounds["max_lat"],
                        region_bounds["min_lon"],
                        region_bounds["max_lon"],
                    )
                frame = _filter_discharge_by_subregion(frame, subregion)
                if not frame.empty:
                    frames.append(frame)
            except Exception as exc:
                logger.error(f"[{state['id']}] Error in GeoParquet basin mean for {file_path}: {exc}")
        if not frames:
            continue
        combined = pd.concat(frames, ignore_index=True)
        values = pd.to_numeric(combined[variable], errors="coerce").dropna()
        if values.empty:
            continue
        results.append(
            {
                "date": date_key,
                "mean_value": float(values.mean()),
                "pixel_count": int(values.count()),
            }
        )
    return results


def query_data(
    state: Dict,
    query_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
) -> List[Dict]:
    if is_geotiff_dataset(state):
        return query_geotiff_data(
            state,
            query_date,
            elev_min,
            elev_max,
            variable,
            subregion=subregion,
        )
    if is_geoparquet_dataset(state):
        return query_geoparquet_data(
            state,
            query_date,
            elev_min,
            elev_max,
            variable,
            subregion=subregion,
        )

    if query_date not in state["date_index"]:
        return []

    date_col = state["date_col"]
    lat_col = state["lat_col"]
    lon_col = state["lon_col"]
    elev_col = state["elev_col"]
    sample_col = state.get("interactive_sample_column")
    exclude_zero = variable.casefold() in {
        str(name).casefold() for name in state.get("map_exclude_zero_variables", ())
    }
    qdate = pd.Timestamp(query_date)

    results: List[Dict] = []
    for file_path in state["date_index"][query_date]:
        try:
            columns_key = (date_col, lat_col, lon_col, elev_col, variable)
            if sample_col:
                columns_key = (*columns_key, sample_col)
            filters = [
                (date_col, "==", qdate.to_pydatetime()),
                (elev_col, ">=", float(elev_min)),
                (elev_col, "<=", float(elev_max)),
            ]
            if sample_col:
                filters.append((sample_col, "==", True))
            if exclude_zero:
                filters.append((variable, "!=", 0))
            if subregion:
                bounds = subregion["bounds"]
                filters.extend(
                    [
                        (lat_col, ">=", float(bounds["min_lat"])),
                        (lat_col, "<=", float(bounds["max_lat"])),
                        (lon_col, ">=", float(bounds["min_lon"])),
                        (lon_col, "<=", float(bounds["max_lon"])),
                    ]
                )
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
            if df.empty:
                continue
            mask = (
                (df[date_col] == qdate)
                & (df[elev_col] >= elev_min)
                & (df[elev_col] <= elev_max)
            )
            if sample_col:
                mask &= df[sample_col].fillna(False).astype(bool)
            numeric_values = pd.to_numeric(df[variable], errors="coerce")
            mask &= numeric_values.notna() & np.isfinite(numeric_values)
            if exclude_zero:
                # Keep this check even with the Arrow filter because
                # read_parquet_subset can fall back to an unfiltered read.
                mask &= numeric_values.ne(0)
            if subregion and mask.any():
                mask &= build_subregion_mask(df, lat_col, lon_col, subregion)
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
    subregion: Optional[Dict[str, Any]] = None,
    region_bounds: Optional[Dict[str, float]] = None,
) -> List[Dict]:
    if is_geotiff_dataset(state):
        return calculate_geotiff_basin_mean(
            state,
            start_date,
            end_date,
            elev_min,
            elev_max,
            variable,
            subregion=subregion,
            region_bounds=region_bounds,
        )
    if is_geoparquet_dataset(state):
        return calculate_geoparquet_basin_mean(
            state,
            start_date,
            end_date,
            elev_min,
            elev_max,
            variable,
            subregion=subregion,
            region_bounds=region_bounds,
        )

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
            columns_key = (date_col, elev_col, variable)
            if region_bounds or subregion:
                columns_key = (date_col, lat_col, lon_col, elev_col, variable)
            filters = [
                (date_col, ">=", start_ts.to_pydatetime()),
                (date_col, "<=", end_ts.to_pydatetime()),
                (elev_col, ">=", float(elev_min)),
                (elev_col, "<=", float(elev_max)),
            ]
            if region_bounds:
                filters.extend(
                    [
                        (lat_col, ">=", float(region_bounds["min_lat"])),
                        (lat_col, "<=", float(region_bounds["max_lat"])),
                        (lon_col, ">=", float(region_bounds["min_lon"])),
                        (lon_col, "<=", float(region_bounds["max_lon"])),
                    ]
                )
            if subregion:
                bounds = subregion["bounds"]
                filters.extend(
                    [
                        (lat_col, ">=", float(bounds["min_lat"])),
                        (lat_col, "<=", float(bounds["max_lat"])),
                        (lon_col, ">=", float(bounds["min_lon"])),
                        (lon_col, "<=", float(bounds["max_lon"])),
                    ]
                )
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
            if df.empty:
                continue
            mask = (
                (df[date_col] >= start_ts)
                & (df[date_col] <= end_ts)
                & (df[elev_col] >= elev_min)
                & (df[elev_col] <= elev_max)
            )
            if region_bounds and mask.any():
                mask &= (
                    (df[lat_col] >= float(region_bounds["min_lat"]))
                    & (df[lat_col] <= float(region_bounds["max_lat"]))
                    & (df[lon_col] >= float(region_bounds["min_lon"]))
                    & (df[lon_col] <= float(region_bounds["max_lon"]))
                )
            if subregion and mask.any():
                mask &= build_subregion_mask(df, lat_col, lon_col, subregion)
            if not mask.any():
                continue

            grouped = (
                df.loc[mask, [date_col, variable]]
                .groupby(date_col, as_index=False)
                .agg(mean_value=(variable, "mean"), pixel_count=(variable, "count"))
            )
            grouped[date_col] = grouped[date_col].dt.strftime("%Y-%m-%d")

            for row in grouped.itertuples(index=False):
                raw_date = getattr(row, date_col)
                results.append(
                    {
                        "date": raw_date,
                        "date_display": format_date_indian(raw_date),
                        "mean_value": float(row.mean_value),
                        "pixel_count": int(row.pixel_count),
                    }
                )
        except Exception as exc:
            logger.error(f"[{state['id']}] Error in basin mean for {file_path}: {exc}")

    results.sort(key=lambda row: row["date"])
    return results


def calculate_hotspot_trends(
    state: Dict,
    year_start: int,
    year_end: int,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
    min_years: int = 3,
) -> Dict[str, Any]:
    """
    Compute long-term change hotspots by fitting a linear trend (value/year)
    at each grid point from annual mean series.
    """
    if is_geotiff_dataset(state) or is_geoparquet_dataset(state):
        return empty_hotspot_result_for_dataset(state, year_start, year_end, min_years)

    date_col = state["date_col"]
    lat_col = state["lat_col"]
    lon_col = state["lon_col"]
    elev_col = state["elev_col"]

    start_ts = pd.Timestamp(f"{year_start}-01-01")
    end_ts = pd.Timestamp(f"{year_end}-12-31")
    dates = sorted([d for d in state["date_index"].keys() if f"{year_start}-01-01" <= d <= f"{year_end}-12-31"])
    if not dates:
        return {
            "summary": {
                "points_analyzed": 0,
                "hotspots_identified": 0,
                "year_start": year_start,
                "year_end": year_end,
                "min_years": min_years,
            },
            "data": [],
            "top_hotspots": [],
        }

    files = sorted(set(file_path for date_key in dates for file_path in state["date_index"][date_key]))
    # Keep each year's intermediate rows bounded.  This avoids concatenating
    # every monthly pixel frame at once for high-resolution datasets.
    grouped_chunks_by_year: Dict[int, List[pd.DataFrame]] = {}
    hotspot_sample_col = state.get("hotspot_sample_column")

    for file_path in files:
        columns_key = (date_col, lat_col, lon_col, elev_col, variable)
        if hotspot_sample_col:
            columns_key = (*columns_key, hotspot_sample_col)
        filters = [
            (date_col, ">=", start_ts.to_pydatetime()),
            (date_col, "<=", end_ts.to_pydatetime()),
            (elev_col, ">=", float(elev_min)),
            (elev_col, "<=", float(elev_max)),
        ]
        if hotspot_sample_col:
            filters.append((hotspot_sample_col, "==", True))
        if subregion:
            bounds = subregion["bounds"]
            filters.extend(
                [
                    (lat_col, ">=", float(bounds["min_lat"])),
                    (lat_col, "<=", float(bounds["max_lat"])),
                    (lon_col, ">=", float(bounds["min_lon"])),
                    (lon_col, "<=", float(bounds["max_lon"])),
                ]
            )

        try:
            df = read_parquet_subset(file_path, columns_key, date_col, filters=filters)
        except Exception as exc:
            logger.error(f"[{state['id']}] Error in hotspot read for {file_path}: {exc}")
            continue

        if df.empty:
            continue

        mask = (
            (df[date_col] >= start_ts)
            & (df[date_col] <= end_ts)
            & (df[elev_col] >= elev_min)
            & (df[elev_col] <= elev_max)
        )
        if hotspot_sample_col:
            mask &= df[hotspot_sample_col].fillna(False).astype(bool)
        if subregion and mask.any():
            mask &= build_subregion_mask(df, lat_col, lon_col, subregion)
        if not mask.any():
            continue

        scoped = df.loc[mask, [date_col, lat_col, lon_col, elev_col, variable]].copy()
        if scoped.empty:
            continue

        scoped["year"] = scoped[date_col].dt.year.astype(int)
        grouped = (
            scoped
            .groupby([lat_col, lon_col, "year"], as_index=False)
            .agg(
                value_sum=(variable, "sum"),
                value_count=(variable, "count"),
                elev_sum=(elev_col, "sum"),
                elev_count=(elev_col, "count"),
            )
        )
        if not grouped.empty:
            for year_value, year_frame in grouped.groupby("year", sort=False):
                grouped_chunks_by_year.setdefault(int(year_value), []).append(year_frame)

    if not grouped_chunks_by_year:
        return {
            "summary": {
                "points_analyzed": 0,
                "hotspots_identified": 0,
                "year_start": year_start,
                "year_end": year_end,
                "min_years": min_years,
            },
            "data": [],
            "top_hotspots": [],
        }

    annual_chunks: List[pd.DataFrame] = []
    for year_value, year_chunks in sorted(grouped_chunks_by_year.items()):
        annual = (
            pd.concat(year_chunks, ignore_index=True)
            .groupby([lat_col, lon_col], as_index=False)
            .agg(
                value_sum=("value_sum", "sum"),
                value_count=("value_count", "sum"),
                elev_sum=("elev_sum", "sum"),
                elev_count=("elev_count", "sum"),
            )
        )
        annual["year"] = year_value
        annual_chunks.append(annual)
    combined = pd.concat(annual_chunks, ignore_index=True)
    combined["annual_mean"] = combined["value_sum"] / combined["value_count"]

    # Vectorized least-squares regression per point.  The former Python loop
    # called np.polyfit tens of thousands of times and dominated MODIS runtime.
    combined = combined[
        (combined["value_count"] > 0)
        & np.isfinite(combined["annual_mean"])
        & np.isfinite(combined["year"])
    ].copy()
    combined["_x"] = combined["year"].astype(np.float64)
    combined["_y"] = combined["annual_mean"].astype(np.float64)
    combined["_xx"] = combined["_x"] * combined["_x"]
    combined["_xy"] = combined["_x"] * combined["_y"]
    combined["_yy"] = combined["_y"] * combined["_y"]
    point_stats = (
        combined.groupby([lat_col, lon_col], as_index=False, sort=False)
        .agg(
            coverage_years=("year", "count"),
            start_year=("year", "min"),
            end_year=("year", "max"),
            sum_x=("_x", "sum"),
            sum_y=("_y", "sum"),
            sum_xx=("_xx", "sum"),
            sum_xy=("_xy", "sum"),
            sum_yy=("_yy", "sum"),
            elev_sum=("elev_sum", "sum"),
            elev_count=("elev_count", "sum"),
        )
    )
    required_coverage = max(2, min_years)
    point_stats = point_stats[point_stats["coverage_years"] >= required_coverage].copy()
    denominator = (
        point_stats["coverage_years"] * point_stats["sum_xx"]
        - point_stats["sum_x"] * point_stats["sum_x"]
    )
    point_stats = point_stats[np.abs(denominator) > np.finfo(np.float64).eps].copy()

    if point_stats.empty:
        return {
            "summary": {
                "points_analyzed": 0,
                "hotspots_identified": 0,
                "year_start": year_start,
                "year_end": year_end,
                "min_years": min_years,
            },
            "data": [],
            "top_hotspots": [],
        }

    denominator = (
        point_stats["coverage_years"] * point_stats["sum_xx"]
        - point_stats["sum_x"] * point_stats["sum_x"]
    )
    point_stats["slope_per_year"] = (
        point_stats["coverage_years"] * point_stats["sum_xy"]
        - point_stats["sum_x"] * point_stats["sum_y"]
    ) / denominator
    point_stats["trend_strength"] = point_stats["slope_per_year"].abs()
    point_stats["total_change"] = point_stats["slope_per_year"] * (
        point_stats["end_year"] - point_stats["start_year"]
    )
    point_stats["annual_mean"] = point_stats["sum_y"] / point_stats["coverage_years"]
    annual_variance = (
        point_stats["sum_yy"] / point_stats["coverage_years"]
        - point_stats["annual_mean"] * point_stats["annual_mean"]
    ).clip(lower=0.0)
    point_stats["annual_std"] = np.sqrt(annual_variance)
    point_stats["elev"] = point_stats["elev_sum"] / point_stats["elev_count"]
    point_stats["direction"] = np.where(point_stats["slope_per_year"] >= 0, "increase", "decrease")

    strengths = point_stats["trend_strength"].to_numpy(dtype=np.float64)
    p70 = float(np.percentile(strengths, 70))
    p85 = float(np.percentile(strengths, 85))
    p95 = float(np.percentile(strengths, 95))
    point_stats["hotspot_level"] = np.select(
        [
            point_stats["trend_strength"] >= p95,
            point_stats["trend_strength"] >= p85,
            point_stats["trend_strength"] >= p70,
        ],
        ["extreme", "high", "moderate"],
        default="low",
    )
    output_columns = [
        lat_col,
        lon_col,
        "elev",
        "slope_per_year",
        "trend_strength",
        "total_change",
        "start_year",
        "end_year",
        "coverage_years",
        "annual_mean",
        "annual_std",
        "direction",
        "hotspot_level",
    ]
    point_stats = point_stats.sort_values("trend_strength", ascending=False)
    point_stats = point_stats[output_columns].rename(columns={lat_col: "lat", lon_col: "lon"})
    for int_column in ("start_year", "end_year", "coverage_years"):
        point_stats[int_column] = point_stats[int_column].astype(int)
    hotspot_rows = point_stats.to_dict("records")
    top_hotspots = hotspot_rows[:20]
    hotspots_identified = int(point_stats["hotspot_level"].isin({"high", "extreme"}).sum())

    summary = {
        "points_analyzed": len(hotspot_rows),
        "hotspots_identified": hotspots_identified,
        "year_start": year_start,
        "year_end": year_end,
        "min_years": min_years,
        "strength_percentiles": {
            "p70": p70,
            "p85": p85,
            "p95": p95,
        },
        "max_strength": float(strengths.max()) if strengths.size else 0.0,
        "mean_strength": float(strengths.mean()) if strengths.size else 0.0,
        "spatially_sampled": bool(hotspot_sample_col),
        "sampling_note": (
            "Trend statistics use the deterministic interactive spatial grid; full-resolution rows remain available in custom analysis."
            if hotspot_sample_col
            else None
        ),
    }

    return {
        "summary": summary,
        "data": hotspot_rows,
        "top_hotspots": top_hotspots,
    }


def build_operation_backend_hooks() -> OperationBackendHooks:
    return OperationBackendHooks(
        ensure_dataset_loaded=ensure_dataset_loaded,
        validate_variable=validate_variable,
        resolve_elevation_bounds=resolve_elevation_bounds,
        normalize_year_range=normalize_year_range,
        get_subregion=get_subregion,
        query_data=query_data,
    )


def register_custom_operations_router() -> None:
    app.include_router(
        build_custom_operations_router(
            hooks=build_operation_backend_hooks(),
            workspace_root=WEBAPP_DIR / "HBapi" / "workspace" / "custom_operations",
        )
    )


register_custom_operations_router()
app.include_router(
    build_export_router(
        hooks=build_operation_backend_hooks(),
        workspace_root=WEBAPP_DIR / "HBapi" / "workspace" / "exports",
    )
)
app.include_router(build_project_workspace_router(WEBAPP_DIR / "HBapi" / "workspace"))
app.include_router(build_research_router(WEBAPP_DIR))
app.include_router(
    build_research_framework_router(
        WEBAPP_DIR,
        OperationDataLoader(build_operation_backend_hooks()),
    )
)




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


class SetDatasetPathRequest(BaseModel):
    path: str


@app.get("/dataset-config")
async def get_dataset_config():
    summary = get_datasets_summary()
    total_files = sum(d["parquet_files"] + d["geotiff_files"] + d["csv_files"] for d in summary)
    ready_count = sum(1 for d in summary if d["ready"])
    return JSONResponse(
        content={
            "database_dir": str(DATABASE_DIR),
            "default_database_dir": str(WEBAPP_DIR / "Database"),
            "is_empty": ready_count == 0,
            "total_files": total_files,
            "ready_datasets": ready_count,
            "datasets": summary,
        }
    )


@app.post("/dataset-config/set-path")
async def set_dataset_path(req: SetDatasetPathRequest):
    raw_path = req.path.strip().strip('"').strip("'")
    if not raw_path:
        raise HTTPException(status_code=400, detail="Path cannot be empty")

    target = Path(raw_path).resolve()
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {raw_path}")

    _update_dataset_base_paths(target)
    init_dataset_state()

    # Persist chosen path to dataset_path.txt
    for save_dest in [WEBAPP_DIR / "dataset_path.txt", WEBAPP_DIR / "backend" / "dataset_path.txt"]:
        try:
            save_dest.parent.mkdir(parents=True, exist_ok=True)
            save_dest.write_text(str(target), encoding="utf-8")
        except Exception as exc:
            logger.warning(f"Could not persist dataset_path.txt to {save_dest}: {exc}")

    summary = get_datasets_summary()
    total_files = sum(d["parquet_files"] + d["geotiff_files"] + d["csv_files"] for d in summary)
    ready_count = sum(1 for d in summary if d["ready"])
    return JSONResponse(
        content={
            "success": True,
            "database_dir": str(DATABASE_DIR),
            "is_empty": ready_count == 0,
            "total_files": total_files,
            "ready_datasets": ready_count,
            "datasets": summary,
        }
    )


@app.get("/outcomes")
async def get_outcomes():
    for outcome_id in OUTCOME_CONFIGS:
        try:
            _load_long_term_hotspot_outcome(outcome_id)
        except HTTPException:
            pass
    return JSONResponse(content={"outcomes": get_outcomes_summary()})


@app.get("/outcomes/{outcome_slug}/meta")
async def get_long_term_hotspot_meta(outcome_slug: str):
    outcome_id = outcome_slug.replace("-", "_")
    config = OUTCOME_CONFIGS.get(outcome_id)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unknown outcome '{outcome_slug}'")
    state = _load_long_term_hotspot_outcome(outcome_id)
    row_count = int(state["df"].shape[0])
    point_count = int(state["df"][["lat", "lon"]].drop_duplicates().shape[0]) if row_count else 0
    return JSONResponse(
        content={
            "outcome_id": outcome_id,
            "label": config["label"],
            "description": state.get("meta", {}).get("description", config["description"]),
            "dataset": config["dataset"],
            "variables": state["variables"],
            "bands": state["bands"],
            "comparisons": state.get("comparisons", []),
            "aggregation_by_variable": state.get("meta", {}).get(
                "aggregation_by_variable",
                {variable: "mean" for variable in state["variables"]},
            ),
            "coverage_by_band": state.get("meta", {}).get("coverage_by_band", []),
            "coverage_by_variable": state.get("meta", {}).get("coverage_by_variable", {}),
            "row_count": row_count,
            "difference_row_count": int(state.get("diff_df", pd.DataFrame()).shape[0]),
            "point_count": point_count,
            "generated_at": state.get("meta", {}).get("generated_at"),
            "differences_generated_at": state.get("diff_meta", {}).get("generated_at"),
            "parquet_path": str(config["parquet"]),
            "difference_parquet_path": str(config["diff_parquet"]),
            "output_directory": config["output_directory"],
        }
    )


@app.get("/outcomes/{outcome_slug}/data")
async def get_long_term_hotspot_data(
    outcome_slug: str,
    variable: Optional[str] = Query(None, description="Variable name"),
    band_id: Optional[str] = Query(None, description="Band id"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
):
    outcome_id = outcome_slug.replace("-", "_")
    config = OUTCOME_CONFIGS.get(outcome_id)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unknown outcome '{outcome_slug}'")
    roi_subregion = _parse_aoi_geojson(aoi_geojson)
    state = _load_long_term_hotspot_outcome(outcome_id)
    variables = state["variables"]
    if not variables:
        raise HTTPException(status_code=404, detail="No variables available in long-term hotspot output")

    selected_variable = variable or variables[0]
    if selected_variable not in variables:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid variable '{selected_variable}'. Choose from: {variables}",
        )

    bands = state["bands"]
    if not bands:
        raise HTTPException(status_code=404, detail="No bands available in long-term hotspot output")

    band_lookup = {str(band["id"]): band for band in bands}
    selected_band_id = str(band_id) if band_id else str(bands[0]["id"])
    if selected_band_id not in band_lookup:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid band_id '{selected_band_id}'. Choose from: {sorted(band_lookup.keys())}",
        )

    df = state["df"]
    filtered = df.loc[(df["variable"] == selected_variable) & (df["band_id"] == selected_band_id)]
    filtered = filter_point_dataframe_by_subregion(filtered, roi_subregion).copy()
    if filtered.empty:
        return JSONResponse(
            content={
                "outcome_id": outcome_id,
                "dataset": config["dataset"],
                "variable": selected_variable,
                "aggregation": state.get("meta", {}).get("aggregation_by_variable", {}).get(selected_variable, "mean"),
                "band": band_lookup[selected_band_id],
                "data": [],
                "count": 0,
                "stats": {"min": None, "max": None, "mean": None},
            }
        )

    filtered = filtered.sort_values(["lat", "lon"], ignore_index=True)
    data = [
        {
            "lat": float(row.lat),
            "lon": float(row.lon),
            "elev": float(row.elev) if pd.notna(row.elev) else None,
            "value": float(row.value),
            "sample_count": int(row.sample_count),
            "band_id": str(row.band_id),
            "band_label": str(row.band_label),
            "start_year": int(row.start_year),
            "end_year": int(row.end_year),
            "variable": str(row.variable),
        }
        for row in filtered.itertuples(index=False)
    ]

    value_series = filtered["value"]
    stats = {
        "min": float(value_series.min()),
        "max": float(value_series.max()),
        "mean": float(value_series.mean()),
    }

    return JSONResponse(
        content={
            "outcome_id": outcome_id,
            "dataset": config["dataset"],
            "variable": selected_variable,
            "aggregation": state.get("meta", {}).get("aggregation_by_variable", {}).get(selected_variable, "mean"),
            "band": band_lookup[selected_band_id],
            "data": data,
            "count": len(data),
            "stats": stats,
        }
    )


@app.get("/outcomes/{outcome_slug}/difference")
async def get_long_term_hotspot_difference(
    outcome_slug: str,
    variable: Optional[str] = Query(None, description="Variable name"),
    comparison_id: Optional[str] = Query(None, description="Saved comparison id"),
    earlier_band_id: Optional[str] = Query(None, description="Earlier/base band id"),
    later_band_id: Optional[str] = Query(None, description="Later/comparison band id"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
):
    outcome_id = outcome_slug.replace("-", "_")
    config = OUTCOME_CONFIGS.get(outcome_id)
    if not config:
        raise HTTPException(status_code=404, detail=f"Unknown outcome '{outcome_slug}'")
    roi_subregion = _parse_aoi_geojson(aoi_geojson)
    state = _load_long_term_hotspot_outcome(outcome_id)
    variables = state["variables"]
    if not variables:
        raise HTTPException(status_code=404, detail="No variables available in long-term hotspot output")

    selected_variable = variable or variables[0]
    if selected_variable not in variables:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid variable '{selected_variable}'. Choose from: {variables}",
        )

    diff_df = state.get("diff_df", pd.DataFrame())
    comparisons = state.get("comparisons", [])
    if diff_df.empty or not comparisons:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{config['label']} difference output not found. "
                f"Run {Path(config['generation_script']).parent / 'compute_band_differences.py'}"
            ),
        )

    comparison_lookup = {str(comparison["id"]): comparison for comparison in comparisons}
    selected_comparison_id = str(comparison_id).strip() if comparison_id else ""

    if not selected_comparison_id and earlier_band_id and later_band_id:
        earlier_key = str(earlier_band_id)
        later_key = str(later_band_id)
        for comparison in comparisons:
            if (
                str(comparison.get("earlier_band_id")) == earlier_key
                and str(comparison.get("later_band_id")) == later_key
            ):
                selected_comparison_id = str(comparison["id"])
                break

    if not selected_comparison_id:
        selected_comparison_id = str(comparisons[0]["id"])

    if selected_comparison_id not in comparison_lookup:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid comparison_id '{selected_comparison_id}'. Choose from: {sorted(comparison_lookup.keys())}",
        )

    comparison = comparison_lookup[selected_comparison_id]
    filtered = diff_df.loc[
        (diff_df["variable"] == selected_variable)
        & (diff_df["id"].astype(str) == selected_comparison_id)
    ]
    filtered = filter_point_dataframe_by_subregion(filtered, roi_subregion).copy()

    if filtered.empty:
        return JSONResponse(
            content={
                "outcome_id": outcome_id,
                "dataset": config["dataset"],
                "variable": selected_variable,
                "aggregation": state.get("meta", {}).get("aggregation_by_variable", {}).get(selected_variable, "mean"),
                "comparison": comparison,
                "data": [],
                "count": 0,
                "stats": {
                    "min_change": None,
                    "max_change": None,
                    "mean_change": None,
                    "mean_abs_change": None,
                    "positive_points": 0,
                    "negative_points": 0,
                },
            }
        )

    filtered = filtered.sort_values(["lat", "lon"], ignore_index=True)
    data = [
        {
            "lat": float(row.lat),
            "lon": float(row.lon),
            "elev": float(row.elev) if pd.notna(row.elev) else None,
            "value": float(row.change_value),
            "change_value": float(row.change_value),
            "abs_change_value": float(row.abs_change_value),
            "pct_change_value": float(row.pct_change_value) if hasattr(row, "pct_change_value") and pd.notna(row.pct_change_value) else None,
            "earlier_value": float(row.earlier_value),
            "later_value": float(row.later_value),
            "earlier_sample_count": int(row.earlier_sample_count),
            "later_sample_count": int(row.later_sample_count),
            "comparison_id": str(row.id),
            "comparison_label": str(row.label),
            "earlier_band_id": str(row.earlier_band_id),
            "earlier_band_label": str(row.earlier_band_label),
            "later_band_id": str(row.later_band_id),
            "later_band_label": str(row.later_band_label),
            "variable": str(row.variable),
        }
        for row in filtered.itertuples(index=False)
    ]

    change_series = filtered["change_value"]
    stats = {
        "min_change": float(change_series.min()),
        "max_change": float(change_series.max()),
        "mean_change": float(change_series.mean()),
        "mean_abs_change": float(filtered["abs_change_value"].mean()),
        "positive_points": int((change_series > 0).sum()),
        "negative_points": int((change_series < 0).sum()),
        "zero_points": int((change_series == 0).sum()),
        # Keep min/max/mean aliases so generic map/info components can reuse the values.
        "min": float(change_series.min()),
        "max": float(change_series.max()),
        "mean": float(change_series.mean()),
    }

    return JSONResponse(
        content={
            "outcome_id": outcome_id,
            "dataset": config["dataset"],
            "variable": selected_variable,
            "aggregation": state.get("meta", {}).get("aggregation_by_variable", {}).get(selected_variable, "mean"),
            "comparison": comparison,
            "data": data,
            "count": len(data),
            "stats": stats,
        }
    )


@app.get("/years")
async def get_available_years(dataset: Optional[str] = Query(None, description="Dataset id")):
    state = ensure_dataset(dataset)
    if is_geotiff_dataset(state):
        geotiff_files = get_geotiff_files(state)
        years = {
            int(date_str[:4])
            for file_path in geotiff_files
            if (date_str := parse_geotiff_date_from_path(file_path))
        }
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
    if is_geoparquet_dataset(state):
        geoparquet_files = get_geoparquet_files(state)
        reference_date = state.get("reference_date")
        years = {
            int(date_str[:4])
            for file_path in geoparquet_files
            if (date_str := parse_geoparquet_date_from_path(file_path, reference_date))
        }
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
            "dates_display": [format_date_indian(d) for d in dates],
            "min_date_display": format_date_indian(dates[0]),
            "max_date_display": format_date_indian(dates[-1]),
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


@app.get("/subregions")
async def get_subregions():
    if not SUBREGION_STATE["loaded"]:
        load_subregion_index()
    return {
        "count": len(SUBREGION_STATE["list"]),
        "subregions": SUBREGION_STATE["list"],
        "source_path": str(SUBREGION_STATE["source_path"]),
    }


@app.get("/subregions/{subregion_id}/geometry")
async def get_subregion_geometry(subregion_id: str):
    subregion = get_subregion(subregion_id)
    if not subregion:
        raise HTTPException(status_code=404, detail="Subregion not found.")

    geometry = subregion.get("geometry")
    if not geometry:
        raise HTTPException(status_code=404, detail=f"No geometry found for '{subregion_id}'.")

    return {
        "id": subregion["id"],
        "label": subregion["label"],
        "kind": subregion.get("kind", "subregion"),
        "bounds": subregion.get("bounds"),
        "feature": {
            "type": "Feature",
            "properties": {
                "id": subregion["id"],
                "label": subregion["label"],
                "kind": subregion.get("kind", "subregion"),
                **(subregion.get("properties") or {}),
            },
            "geometry": geometry,
        },
    }


@app.get("/glaciers/overview")
async def get_glacier_overview(
    min_lat: Optional[float] = Query(None, description="Viewport min latitude"),
    max_lat: Optional[float] = Query(None, description="Viewport max latitude"),
    min_lon: Optional[float] = Query(None, description="Viewport min longitude"),
    max_lon: Optional[float] = Query(None, description="Viewport max longitude"),
    subregion_id: Optional[str] = Query(None, description="Optional exact subregion polygon"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
    nearby_buffer_km: float = Query(
        GLACIER_ROI_NEARBY_BUFFER_KM,
        ge=0.0,
        le=25.0,
        description="Nearby buffer around ROI used when loading glacier outlines",
    ),
    complete_within_bbox: bool = Query(False, description="Load the complete glacier set within selected bounds"),
    zoom: float = Query(6.0, ge=0.0, le=22.0, description="Current map zoom"),
    max_features: int = Query(
        GLACIER_OVERVIEW_DEFAULT_MAX_FEATURES,
        ge=100,
        le=GLACIER_OVERVIEW_MAX_FEATURES_LIMIT,
        description="Upper feature cap for this response",
    ),
):
    _ensure_glacier_vector_reader()

    bbox = _validate_glacier_bbox(min_lat=min_lat, max_lat=max_lat, min_lon=min_lon, max_lon=max_lon)
    aoi_subregion = _parse_aoi_geojson(aoi_geojson)
    selected_subregion = None if aoi_subregion else get_subregion(subregion_id)
    selection_subregion = aoi_subregion or selected_subregion
    active_nearby_buffer_km = float(nearby_buffer_km) if aoi_subregion else 0.0
    if aoi_subregion:
        complete_within_bbox = True
        bounds = aoi_subregion["bounds"]
        bbox = _expand_wgs84_bbox_by_km(
            (
                float(bounds["min_lon"]),
                float(bounds["min_lat"]),
                float(bounds["max_lon"]),
                float(bounds["max_lat"]),
            ),
            active_nearby_buffer_km,
        )
    if selected_subregion and bbox is None:
        bounds = selected_subregion["bounds"]
        bbox = (
            float(bounds["min_lon"]),
            float(bounds["min_lat"]),
            float(bounds["max_lon"]),
            float(bounds["max_lat"]),
        )
    if complete_within_bbox and bbox is None:
        raise HTTPException(status_code=400, detail="complete_within_bbox requires viewport bounds or subregion_id")
    simplify_tolerance = _glacier_simplify_tolerance(zoom)
    max_features = int(max(100, min(int(max_features), GLACIER_OVERVIEW_MAX_FEATURES_LIMIT)))
    source_signature, glacier_sources = _discover_glacier_polygon_sources()

    if not glacier_sources:
        return {
            "feature_collection": {"type": "FeatureCollection", "features": []},
            "meta": {
                "count": 0,
                "truncated": False,
                "simplify_tolerance": simplify_tolerance,
                "bbox": None,
                "zoom": zoom,
                "source_count": 0,
                "cached": False,
            },
        }

    cache_key = _make_glacier_overview_cache_key(
        source_signature=source_signature,
        bbox=bbox,
        zoom=zoom,
        max_features=max_features,
        simplify_tolerance=simplify_tolerance,
        subregion_id=selected_subregion["id"] if selected_subregion else None,
        aoi_signature=_make_aoi_cache_signature(aoi_subregion),
        nearby_buffer_km=active_nearby_buffer_km,
    )
    cached_payload = GLACIER_OVERVIEW_CACHE.get(cache_key)
    if cached_payload is not None:
        GLACIER_OVERVIEW_CACHE.move_to_end(cache_key)
        cached_meta = dict(cached_payload.get("meta") or {})
        cached_meta["cached"] = True
        return {
            "feature_collection": cached_payload.get("feature_collection", {"type": "FeatureCollection", "features": []}),
            "meta": cached_meta,
        }

    features: List[Dict[str, Any]] = []
    scanned_rows = 0
    source_count = len(glacier_sources)
    per_source_read_limit = None if complete_within_bbox else min(
        GLACIER_OVERVIEW_READ_MAX_ROWS,
        max_features * GLACIER_OVERVIEW_READ_MULTIPLIER,
    )
    selection_geometry = _build_nearby_glacier_selection_geometry(
        selection_subregion,
        active_nearby_buffer_km,
    )

    for source in glacier_sources:
        vector_path = Path(source["path"])
        if not vector_path.exists():
            logger.warning("Glacier vector source missing during overview read: %s", vector_path)
            continue

        source_id_col = str(source.get("id_col") or "")
        source_name_col = str(source.get("name_col") or "")
        source_area_col = str(source.get("area_col") or "")
        source_date_col = str(source.get("date_col") or "")
        source_line_type_col = str(source.get("line_type_col") or "")
        source_line_type_value = _normalize_glacier_text(source.get("line_type_value"))

        read_columns = [
            column
            for column in [source_id_col, source_name_col, source_area_col, source_date_col, source_line_type_col]
            if column
        ]
        if not read_columns:
            read_columns = None

        try:
            frame = _read_glacier_dataframe(
                vector_path,
                columns=read_columns,
                bbox=bbox,
                max_features=per_source_read_limit,
            )
        except Exception as exc:
            logger.warning("Failed reading glacier vector source '%s': %s", vector_path, exc)
            continue

        if frame.empty:
            continue
        scanned_rows += int(len(frame))

        if source_line_type_col and source_line_type_col in frame.columns and source_line_type_value:
            line_values = frame[source_line_type_col].map(_normalize_glacier_text)
            frame = frame[line_values == source_line_type_value]
            if frame.empty:
                continue

        frame_crs = getattr(frame, "crs", None)
        if frame_crs is not None:
            try:
                epsg = frame_crs.to_epsg() if hasattr(frame_crs, "to_epsg") else None
            except Exception:
                epsg = None
            if epsg not in (None, 4326):
                if hasattr(frame, "to_crs"):
                    try:
                        frame = frame.to_crs("EPSG:4326")
                    except Exception as exc:
                        logger.warning("Skipping '%s' due to CRS transform failure: %s", vector_path, exc)
                        continue

        if source_id_col not in frame.columns:
            continue

        frame = frame.copy()
        frame[source_id_col] = frame[source_id_col].astype(str).str.strip()
        frame = frame[frame[source_id_col] != ""]
        if frame.empty:
            continue

        if source_name_col and source_name_col in frame.columns:
            frame["_normalized_glacier_name"] = frame[source_name_col].map(_normalize_glacier_text)
        else:
            frame["_normalized_glacier_name"] = ""

        frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty]
        if frame.empty:
            continue

        invalid_mask = ~frame.geometry.is_valid
        if invalid_mask.any():
            frame = frame.copy()
            frame.loc[invalid_mask, "geometry"] = frame.loc[invalid_mask, "geometry"].buffer(0)
            frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty]
            if frame.empty:
                continue

        if selection_geometry is not None:
            frame = frame[frame.geometry.intersects(selection_geometry)]
            if frame.empty:
                continue

        if simplify_tolerance > 0:
            frame = frame.copy()
            frame["geometry"] = frame.geometry.simplify(simplify_tolerance, preserve_topology=True)
            frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty]
            if frame.empty:
                continue

        if source_area_col and source_area_col in frame.columns:
            frame["_area_km2"] = pd.to_numeric(frame[source_area_col], errors="coerce")
        else:
            frame["_area_km2"] = np.nan

        if source_date_col and source_date_col in frame.columns:
            frame["_date_key"] = frame[source_date_col].fillna("").astype(str).str.strip()
        else:
            frame["_date_key"] = ""

        frame = frame.sort_values(
            by=["_date_key", "_area_km2"],
            ascending=[False, False],
            na_position="last",
        )
        frame = frame.drop_duplicates(subset=[source_id_col], keep="first")
        frame = frame.sort_values(by="_area_km2", ascending=False, na_position="last")

        for _, row in frame.iterrows():
            native_id = str(row.get(source_id_col) or "").strip()
            if not native_id:
                continue

            geometry_obj = row.geometry
            if geometry_obj is None or geometry_obj.is_empty:
                continue

            glacier_name = _normalize_glacier_text(row.get("_normalized_glacier_name")) or native_id

            props = {
                "id": f"{GLACIER_ID_PREFIX}{native_id}",
                "kind": "glacier",
                "rgi_id": native_id,
                "glacier_name": glacier_name,
                "source": source.get("kind"),
            }
            area_km2 = _safe_float(row.get("_area_km2"))
            if area_km2 is not None:
                props["area_km2"] = area_km2
            date_value = _normalize_glacier_text(row.get("_date_key"))
            if date_value:
                props["src_date"] = date_value

            features.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": geometry_obj.__geo_interface__,
                }
            )
            if len(features) >= max_features:
                break

        if len(features) >= max_features:
            break

    truncated = len(features) >= max_features
    bbox_meta = None
    if bbox:
        bbox_meta = {
            "min_lon": bbox[0],
            "min_lat": bbox[1],
            "max_lon": bbox[2],
            "max_lat": bbox[3],
        }

    payload = {
        "feature_collection": {
            "type": "FeatureCollection",
            "features": features,
        },
        "meta": {
            "count": len(features),
            "truncated": truncated,
            "max_features": max_features,
            "zoom": zoom,
            "simplify_tolerance": simplify_tolerance,
            "bbox": bbox_meta,
            "scanned_rows": scanned_rows,
            "source_count": source_count,
            "subregion_id": selected_subregion["id"] if selected_subregion else None,
            "roi_id": aoi_subregion["id"] if aoi_subregion else None,
            "filter_source": "roi" if aoi_subregion else ("subregion" if selected_subregion else "viewport"),
            "nearby_buffer_km": active_nearby_buffer_km,
            "complete_within_bbox": complete_within_bbox,
            "cached": False,
        },
    }
    GLACIER_OVERVIEW_CACHE[cache_key] = payload
    GLACIER_OVERVIEW_CACHE.move_to_end(cache_key)
    while len(GLACIER_OVERVIEW_CACHE) > GLACIER_OVERVIEW_CACHE_MAX_ENTRIES:
        GLACIER_OVERVIEW_CACHE.popitem(last=False)
    return payload


@app.post("/nc/upload")
async def upload_nc_dataset(
    file: UploadFile = File(...),
    dataset_name: Optional[str] = Form(None),
):
    ensure_uploaded_nc_dirs()

    original_name = file.filename or "uploaded.nc"
    suffix = Path(original_name).suffix.lower()
    allowed_suffixes = {".nc", ".nc4", ".cdf", ".netcdf"}
    if suffix not in allowed_suffixes:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Use .nc/.nc4/.cdf/.netcdf",
        )

    user_name = (dataset_name or Path(original_name).stem).strip()
    dataset_id = generate_dataset_id(user_name)
    dataset_label = build_uploaded_dataset_label(user_name)
    dataset_dir = UPLOADED_NC_ROOT / dataset_id
    uploaded_copy = UPLOADED_NC_FILES_DIR / f"{dataset_id}{suffix}"

    conversion_summary: Optional[Dict[str, Any]] = None
    try:
        dataset_dir.mkdir(parents=True, exist_ok=False)
        with uploaded_copy.open("wb") as output:
            shutil.copyfileobj(file.file, output)

        conversion_summary = convert_nc_to_parquet(
            uploaded_copy,
            dataset_dir,
            dataset_prefix=f"NC_{slugify(user_name)}",
        )

        add_uploaded_dataset_entry(
            UPLOADED_NC_MANIFEST,
            dataset_id=dataset_id,
            label=dataset_label,
            dataset_path=dataset_dir,
            source_file=uploaded_copy,
            conversion_summary=conversion_summary,
        )

        init_dataset_state()
        loaded = ensure_dataset_loaded(dataset_id)
        years = sorted({int(date_key[:4]) for date_key in loaded["date_index"].keys()})

        return {
            "status": "ok",
            "dataset_id": dataset_id,
            "dataset_label": dataset_label,
            "dataset_path": str(dataset_dir),
            "source_file": str(uploaded_copy),
            "years": years,
            "variables": loaded["variables"],
            "conversion": conversion_summary,
        }
    except HTTPException:
        raise
    except Exception as exc:
        if dataset_dir.exists():
            shutil.rmtree(dataset_dir, ignore_errors=True)
        if uploaded_copy.exists():
            uploaded_copy.unlink(missing_ok=True)
        logger.exception("NC upload conversion failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"NC ingestion failed: {exc}") from exc
    finally:
        try:
            await file.close()
        except Exception:
            pass


@app.get("/data")
async def get_data(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    variable: Optional[str] = Query(None, description="Variable name"),
    subregion_id: Optional[str] = Query(None, description="Optional subregion id"),
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
):
    try:
        date = parse_and_normalize_date(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format. Use DD-MM-YYYY or YYYY-MM-DD") from exc

    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)
    subregion = resolve_query_subregion(subregion_id, aoi_geojson)

    start_time = datetime.now()
    query_state = snapshot_dataset_state(state)
    data = await run_in_threadpool(
        query_data,
        query_state,
        date,
        elev_min,
        elev_max,
        var_name,
        subregion,
    )
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    subregion_log = f", subregion={subregion['id']}" if subregion else ""
    logger.info(
        f"[{state['id']}] Query {date} [{elev_min}-{elev_max}m] {var_name}: "
        f"{len(data)} points in {query_time:.0f}ms{subregion_log}"
    )
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "date": date,
            "date_display": format_date_indian(date),
            "elev_min": elev_min,
            "elev_max": elev_max,
            "variable": var_name,
            "subregion_id": subregion["id"] if subregion else None,
            "subregion_label": subregion["label"] if subregion else None,
            "bounds": subregion["bounds"] if subregion else None,
            "year_start": year_start,
            "year_end": year_end,
            "data": data,
            "count": len(data),
            "query_time_ms": round(query_time, 2),
        },
        headers={"Cache-Control": "private, max-age=120"},
    )


@app.get("/basin-mean")
async def get_basin_mean(
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    variable: Optional[str] = Query(None, description="Variable name"),
    subregion_id: Optional[str] = Query(None, description="Optional subregion id"),
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
):
    try:
        start_date = parse_and_normalize_date(start_date)
        end_date = parse_and_normalize_date(end_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format. Use DD-MM-YYYY or YYYY-MM-DD") from exc

    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)
    subregion = resolve_query_subregion(subregion_id, aoi_geojson)

    start_time = datetime.now()
    query_state = snapshot_dataset_state(state)
    data = await run_in_threadpool(
        calculate_basin_mean,
        query_state,
        start_date,
        end_date,
        elev_min,
        elev_max,
        var_name,
        subregion,
        None,
    )
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    subregion_log = f", subregion={subregion['id']}" if subregion else ""
    logger.info(
        f"[{state['id']}] Basin mean [{start_date} to {end_date}] [{elev_min}-{elev_max}m] {var_name}: "
        f"{len(data)} days in {query_time:.0f}ms{subregion_log}"
    )
    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "start_date": start_date,
            "end_date": end_date,
            "start_date_display": format_date_indian(start_date),
            "end_date_display": format_date_indian(end_date),
            "elev_min": elev_min,
            "elev_max": elev_max,
            "variable": var_name,
            "subregion_id": subregion["id"] if subregion else None,
            "subregion_label": subregion["label"] if subregion else None,
            "bounds": subregion["bounds"] if subregion else None,
            "year_start": year_start,
            "year_end": year_end,
            "data": data,
            "count": len(data),
            "query_time_ms": round(query_time, 2),
        },
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/hotspot-trends")
async def get_hotspot_trends(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    variable: Optional[str] = Query(None, description="Variable name"),
    elev_min: Optional[float] = Query(None, description="Minimum elevation"),
    elev_max: Optional[float] = Query(None, description="Maximum elevation"),
    subregion_id: Optional[str] = Query(None, description="Optional subregion id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
    min_years: int = Query(3, description="Minimum yearly coverage per point"),
    aoi_geojson: Optional[str] = Query(None, description="Optional ROI Polygon/MultiPolygon GeoJSON"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    var_name = validate_variable(state, variable)
    elev_min, elev_max = resolve_elevation_bounds(state, elev_min, elev_max)
    subregion = resolve_query_subregion(subregion_id, aoi_geojson)

    if min_years < 2:
        raise HTTPException(status_code=400, detail="min_years must be at least 2")

    indexed_years = sorted({int(date_key[:4]) for date_key in state["date_index"].keys()})
    if not indexed_years:
        return JSONResponse(
            content={
                "dataset": state["id"],
                "dataset_label": state["label"],
                "variable": var_name,
                "year_start": year_start,
                "year_end": year_end,
                "summary": {
                    "points_analyzed": 0,
                    "hotspots_identified": 0,
                    "min_years": min_years,
                },
                "data": [],
                "top_hotspots": [],
                "query_time_ms": 0.0,
            }
        )

    analysis_start_year = year_start if year_start is not None else indexed_years[0]
    analysis_end_year = year_end if year_end is not None else indexed_years[-1]
    if analysis_start_year > analysis_end_year:
        raise HTTPException(status_code=400, detail="Invalid year range for hotspot analysis")

    start_time = datetime.now()
    query_state = snapshot_dataset_state(state)
    result = await run_in_threadpool(
        calculate_hotspot_trends,
        query_state,
        analysis_start_year,
        analysis_end_year,
        elev_min,
        elev_max,
        var_name,
        subregion,
        min_years,
    )
    query_time = (datetime.now() - start_time).total_seconds() * 1000

    subregion_log = f", subregion={subregion['id']}" if subregion else ""
    logger.info(
        f"[{state['id']}] Hotspot trend [{analysis_start_year}-{analysis_end_year}] "
        f"[{elev_min}-{elev_max}m] {var_name}: {result['summary']['points_analyzed']} points in {query_time:.0f}ms{subregion_log}"
    )

    return JSONResponse(
        content={
            "dataset": state["id"],
            "dataset_label": state["label"],
            "variable": var_name,
            "elev_min": elev_min,
            "elev_max": elev_max,
            "subregion_id": subregion["id"] if subregion else None,
            "subregion_label": subregion["label"] if subregion else None,
            "year_start": analysis_start_year,
            "year_end": analysis_end_year,
            "summary": result["summary"],
            "data": result["data"],
            "top_hotspots": result["top_hotspots"],
            "query_time_ms": round(query_time, 2),
        },
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/stats")
async def get_stats(
    dataset: Optional[str] = Query(None, description="Dataset id"),
    year_start: Optional[int] = Query(None, description="Inclusive start year"),
    year_end: Optional[int] = Query(None, description="Inclusive end year"),
):
    year_start, year_end = normalize_year_range(year_start, year_end)
    state = ensure_dataset_loaded(dataset, year_start=year_start, year_end=year_end)
    if is_geotiff_dataset(state):
        return get_geotiff_stats_payload(state, year_start, year_end)
    if is_geoparquet_dataset(state):
        geoparquet_files = get_geoparquet_files(state)
        filtered_files = select_geoparquet_files_for_year_range(
            geoparquet_files,
            year_start,
            year_end,
            state.get("reference_date"),
        )
        total_size = sum(file_path.stat().st_size for file_path in filtered_files)
        sample_file = filtered_files[0] if filtered_files else geoparquet_files[0]
        ensure_geopandas_available()
        sample_frame = gpd.read_parquet(sample_file)  # type: ignore[union-attr]
        sample_stats = {
            "columns": list(sample_frame.columns),
            "sample_records": int(len(sample_frame)),
            "geometry_types": {
                str(key): int(value)
                for key, value in sample_frame.geom_type.value_counts(dropna=False).to_dict().items()
            },
        }
        stats_variable = state.get("default_variable")
        if stats_variable in sample_frame.columns:
            values = pd.to_numeric(sample_frame[stats_variable], errors="coerce").dropna()
            if not values.empty:
                sample_stats["value_range"] = {
                    "min": float(values.min()),
                    "max": float(values.max()),
                    "mean": float(values.mean()),
                }

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
            "sample_stats": sample_stats,
        }

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
