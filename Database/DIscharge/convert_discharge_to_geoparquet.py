"""
Convert discharge shapefiles to GeoParquet without changing attributes,
geometry, or CRS.

Edit SOURCE_DIR_PATH and OUTPUT_DIR_PATH below before running when needed.
Works on Windows and Linux/RHEL as long as geopandas/pyarrow are installed.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List

import geopandas as gpd
import pandas as pd


SOURCE_DIR_PATH = r"D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Database\DIscharge"
OUTPUT_DIR_PATH = r"D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\Database\Dischare_Geopar"

SHAPEFILE_PATTERN = "*.shp"
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("discharge_geoparquet")


def crs_text(gdf: gpd.GeoDataFrame) -> str | None:
    return gdf.crs.to_wkt() if gdf.crs is not None else None


def rounded_bounds(gdf: gpd.GeoDataFrame) -> List[float] | None:
    if gdf.empty:
        return None
    return [round(float(value), 12) for value in gdf.total_bounds]


def geometry_type_counts(gdf: gpd.GeoDataFrame) -> Dict[str, int]:
    counts = gdf.geom_type.value_counts(dropna=False).to_dict()
    return {str(key): int(value) for key, value in counts.items()}


def dataframe_attributes_equal(source: gpd.GeoDataFrame, converted: gpd.GeoDataFrame) -> bool:
    source_attrs = source.drop(columns="geometry", errors="ignore").reset_index(drop=True)
    converted_attrs = converted.drop(columns="geometry", errors="ignore").reset_index(drop=True)
    return source_attrs.equals(converted_attrs)


def geometry_wkb_equal(source: gpd.GeoDataFrame, converted: gpd.GeoDataFrame) -> bool:
    source_wkb = source.geometry.to_wkb().reset_index(drop=True)
    converted_wkb = converted.geometry.to_wkb().reset_index(drop=True)
    return source_wkb.equals(converted_wkb)


def verify_lossless(
    source_gdf: gpd.GeoDataFrame,
    converted_gdf: gpd.GeoDataFrame,
) -> Dict[str, bool]:
    source_columns = list(source_gdf.columns)
    converted_columns = list(converted_gdf.columns)
    return {
        "row_count_match": len(source_gdf) == len(converted_gdf),
        "column_names_match": source_columns == converted_columns,
        "crs_match": crs_text(source_gdf) == crs_text(converted_gdf),
        "geometry_non_null_count_match": int(source_gdf.geometry.notna().sum()) == int(converted_gdf.geometry.notna().sum()),
        "geometry_type_counts_match": geometry_type_counts(source_gdf) == geometry_type_counts(converted_gdf),
        "bounds_match_rounded_12dp": rounded_bounds(source_gdf) == rounded_bounds(converted_gdf),
        "attribute_values_match": dataframe_attributes_equal(source_gdf, converted_gdf),
        "geometry_wkb_match": geometry_wkb_equal(source_gdf, converted_gdf),
    }


def convert_one(source_shp: Path, output_dir: Path) -> Path:
    output_parquet = output_dir / f"{source_shp.stem}.parquet"

    logger.info("Reading %s", source_shp.name)
    source_gdf = gpd.read_file(source_shp)

    logger.info("Writing %s", output_parquet.name)
    source_gdf.to_parquet(
        output_parquet,
        compression="snappy",
        geometry_encoding="WKB",
        write_covering_bbox=True,
        index=False,
    )

    logger.info("Round-trip verifying %s", output_parquet.name)
    converted_gdf = gpd.read_parquet(output_parquet)
    checks = verify_lossless(source_gdf, converted_gdf)

    if not all(checks.values()):
        failed_checks = [key for key, passed in checks.items() if not passed]
        raise RuntimeError(f"Lossless verification failed for {source_shp.name}: {failed_checks}")

    source_size = sum(sidecar.stat().st_size for sidecar in source_shp.parent.glob(f"{source_shp.stem}.*"))
    output_size = output_parquet.stat().st_size
    logger.info(
        "OK %s: rows=%s, source_group=%.2f MB, parquet=%.2f MB",
        source_shp.name,
        f"{len(source_gdf):,}",
        source_size / (1024 * 1024),
        output_size / (1024 * 1024),
    )
    return output_parquet


def main() -> None:
    source_dir = Path(SOURCE_DIR_PATH).expanduser().resolve()
    output_dir = Path(OUTPUT_DIR_PATH).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    shapefiles = sorted(source_dir.glob(SHAPEFILE_PATTERN))
    if not shapefiles:
        raise FileNotFoundError(f"No shapefiles found in {source_dir}")

    logger.info("=" * 72)
    logger.info("Discharge Shapefile to GeoParquet Conversion")
    logger.info("Source: %s", source_dir)
    logger.info("Output: %s", output_dir)
    logger.info("Shapefiles discovered: %d", len(shapefiles))
    logger.info("=" * 72)

    written: List[Path] = []
    for shapefile in shapefiles:
        written.append(convert_one(shapefile, output_dir))

    logger.info("=" * 72)
    logger.info("Completed. parquet_files=%d all_passed=True", len(written))
    logger.info("=" * 72)


if __name__ == "__main__":
    main()
