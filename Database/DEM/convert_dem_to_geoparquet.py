"""Convert a large DEM GeoTIFF into a web-ready GeoParquet point grid.

The source raster can contain billions of pixels, so the converter uses
area-averaging to produce a bounded overview grid.  Each retained cell is
stored as a WGS84 point with an ``elevation_m`` attribute.  Source and
sampling details are preserved in Parquet schema metadata.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import geopandas as gpd
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import xy


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCES = [
    Path(r"C:\Users\DC\Downloads\Himalaya_SRTM_DEM-0000000000-0000000000.tif"),
    Path(r"C:\Users\DC\Downloads\Himalaya_SRTM_DEM-0000000000-0000046592.tif"),
]
DEFAULT_OUTPUT = SCRIPT_DIR / "Himalaya_SRTM_DEM-0000000000-0000000000.parquet"
DEFAULT_MANIFEST = SCRIPT_DIR / "manifest.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert one or more aligned DEM tiles to web-ready GeoParquet.")
    parser.add_argument("sources", type=Path, nargs="*", default=DEFAULT_SOURCES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--max-grid-cells",
        type=int,
        default=300_000,
        help="Maximum overview cells before zero/nodata removal (default: 300000).",
    )
    parser.add_argument(
        "--include-zero",
        action="store_true",
        help="Keep zero-valued cells. By default they are treated as the source's unset background.",
    )
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def _json_metadata(metadata: Dict[str, Any]) -> Dict[bytes, bytes]:
    return {
        b"dem": json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode("utf-8"),
        b"dem_sources": json.dumps(metadata["sources"], separators=(",", ":")).encode("utf-8"),
        b"dem_sampling_factor": str(metadata["sampling_factor"]).encode("ascii"),
    }


def convert_dem(
    sources: list[Path],
    output: Path,
    *,
    max_grid_cells: int = 300_000,
    include_zero: bool = False,
    overwrite: bool = False,
) -> Dict[str, Any]:
    sources = [source.resolve() for source in sources]
    output = output.resolve()
    if not sources:
        raise ValueError("At least one DEM source is required")
    missing_sources = [source for source in sources if not source.is_file()]
    if missing_sources:
        raise FileNotFoundError(f"DEM source not found: {missing_sources[0]}")
    if output.exists() and not overwrite:
        raise FileExistsError(f"Output already exists (use --overwrite): {output}")
    if max_grid_cells < 1:
        raise ValueError("max_grid_cells must be positive")

    source_cells = 0
    reference_crs = None
    reference_resolution = None
    tile_metadata: list[Dict[str, Any]] = []
    for source in sources:
        with rasterio.open(source) as src:
            if src.count != 1:
                raise ValueError(f"Expected a single-band DEM, found {src.count} bands in {source}")
            if src.crs is None:
                raise ValueError(f"The DEM has no CRS: {source}")
            resolution = (abs(float(src.transform.a)), abs(float(src.transform.e)))
            if reference_crs is None:
                reference_crs = src.crs
                reference_resolution = resolution
            elif src.crs != reference_crs or not np.allclose(resolution, reference_resolution):
                raise ValueError(f"DEM tile CRS or pixel size does not match the first tile: {source}")
            source_cells += int(src.width * src.height)

    factor = max(1, int(math.ceil(math.sqrt(source_cells / max_grid_cells))))
    frames: list[gpd.GeoDataFrame] = []
    overview_cells = 0

    for source in sources:
        with rasterio.open(source) as src:
            out_width = max(1, int(math.ceil(src.width / factor)))
            out_height = max(1, int(math.ceil(src.height / factor)))
            overview = src.read(
                1,
                out_shape=(out_height, out_width),
                masked=True,
                resampling=Resampling.average,
            )
            overview_transform = src.transform * src.transform.scale(
                src.width / out_width,
                src.height / out_height,
            )

            values = np.asarray(overview.data, dtype=np.float32)
            mask = ~np.ma.getmaskarray(overview)
            mask &= np.isfinite(values)
            if not include_zero:
                mask &= values != 0

            rows, cols = np.where(mask)
            overview_cells += int(out_width * out_height)
            if rows.size == 0:
                continue

            xs, ys = xy(overview_transform, rows, cols, offset="center")
            tile_frame = gpd.GeoDataFrame(
                {"elevation_m": values[rows, cols]},
                geometry=gpd.points_from_xy(xs, ys, crs=src.crs),
                crs=src.crs,
            )
            if tile_frame.crs.to_epsg() != 4326:
                tile_frame = tile_frame.to_crs("EPSG:4326")
            frames.append(tile_frame)

            bounds = src.bounds
            tile_metadata.append({
                "source": str(source),
                "width": int(src.width),
                "height": int(src.height),
                "cells": int(src.width * src.height),
                "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
                "overview_width": out_width,
                "overview_height": out_height,
                "retained_cells": int(len(tile_frame)),
            })

    if not frames:
        raise ValueError("No valid DEM cells remain after nodata/zero filtering")

    frame = gpd.GeoDataFrame(
        pd.concat(frames, ignore_index=True),
        geometry="geometry",
        crs="EPSG:4326",
    )
    source_bounds = [
        min(tile["bounds"][0] for tile in tile_metadata),
        min(tile["bounds"][1] for tile in tile_metadata),
        max(tile["bounds"][2] for tile in tile_metadata),
        max(tile["bounds"][3] for tile in tile_metadata),
    ]
    metadata: Dict[str, Any] = {
        "format": "web-overview-point-grid",
        "sources": [str(source) for source in sources],
        "source_tiles": tile_metadata,
        "source_crs": reference_crs.to_string() if reference_crs else None,
        "source_cells": source_cells,
        "source_bounds": source_bounds,
        "source_pixel_size": list(reference_resolution) if reference_resolution else None,
        "sampling_factor": factor,
        "overview_cells": overview_cells,
        "retained_cells": int(len(frame)),
        "zero_cells_excluded": not include_zero,
        "elevation_min_m": float(frame["elevation_m"].min()),
        "elevation_max_m": float(frame["elevation_m"].max()),
        "elevation_mean_m": float(frame["elevation_m"].mean()),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(output, index=False, compression="zstd", schema_version="1.1.0")

    table = pq.read_table(output)
    schema_metadata = dict(table.schema.metadata or {})
    schema_metadata.update(_json_metadata(metadata))
    pq.write_table(
        table.replace_schema_metadata(schema_metadata),
        output,
        compression="zstd",
        write_statistics=True,
    )

    metadata["output"] = str(output)
    metadata["output_size_bytes"] = output.stat().st_size
    DEFAULT_MANIFEST.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def main() -> None:
    args = parse_args()
    metadata = convert_dem(
        args.sources,
        args.output,
        max_grid_cells=args.max_grid_cells,
        include_zero=args.include_zero,
        overwrite=args.overwrite,
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
