"""Convert the MOD10A1 monthly GeoTIFF collection to analysis-ready Parquet.

The output keeps every pixel for scientific aggregation and adds a deterministic
``_map_sample`` flag used only by the interactive map endpoint.  Raster cells are
stored as latitude/longitude points instead of WKB geometry because point columns
are substantially smaller and are already the webapp's native analysis schema.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio


LOGGER = logging.getLogger("mod10a1_parquet")
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE_DIR = SCRIPT_DIR / "MOD10A1_Monthly_GeoTIFF"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "MOD10A1_Parquet"
FILE_PATTERN = re.compile(r"^MOD10A1_(\d{4})_(\d{2})$", re.IGNORECASE)
BASE_COLUMNS = {"date", "latitude", "longitude", "elevation_m", "_map_sample"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert MOD10A1 monthly GeoTIFFs to Parquet.")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--max-map-points", type=int, default=75_000)
    parser.add_argument("--row-group-size", type=int, default=65_536)
    return parser.parse_args()


def parse_date(path: Path) -> tuple[str, np.datetime64]:
    match = FILE_PATTERN.match(path.stem)
    if not match:
        raise ValueError(f"Unexpected filename '{path.name}'; expected MOD10A1_YYYY_MM.tif")
    year, month = map(int, match.groups())
    if not 1 <= month <= 12:
        raise ValueError(f"Invalid month in '{path.name}'")
    date_text = f"{year:04d}-{month:02d}-01"
    return date_text, np.datetime64(date_text, "ms")


def unique_band_names(descriptions: tuple[str | None, ...]) -> list[str]:
    names: list[str] = []
    used: set[str] = set()
    for index, description in enumerate(descriptions, start=1):
        base = re.sub(r"[^A-Za-z0-9_]+", "_", (description or f"band_{index}").strip()).strip("_")
        base = base or f"band_{index}"
        name = base
        suffix = 2
        while name in used or name in BASE_COLUMNS:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name)
        names.append(name)
    return names


def coordinate_vectors(src: rasterio.io.DatasetReader) -> tuple[np.ndarray, np.ndarray]:
    transform = src.transform
    if not transform.is_rectilinear:
        raise ValueError(f"Rotated rasters are not supported: {src.name}")
    cols = np.arange(src.width, dtype=np.float64) + 0.5
    rows = np.arange(src.height, dtype=np.float64) + 0.5
    longitude = transform.c + cols * transform.a
    latitude = transform.f + rows * transform.e
    return latitude, longitude


def map_stride(valid_count: int, max_map_points: int) -> int:
    if max_map_points <= 0:
        raise ValueError("max_map_points must be positive")
    return max(1, int(math.ceil(math.sqrt(valid_count / max_map_points))))


def raster_to_table(path: Path, max_map_points: int) -> tuple[pa.Table, dict[str, Any]]:
    date_text, date_value = parse_date(path)
    with rasterio.open(path) as src:
        if src.crs is None:
            raise ValueError(f"Missing CRS in {path.name}")
        if src.crs.to_epsg() != 4326:
            raise ValueError(f"{path.name} must be EPSG:4326; found {src.crs}")

        data = src.read().astype(np.float32, copy=False)
        valid = np.isfinite(data)
        union_mask = np.any(valid, axis=0)
        rows, cols = np.nonzero(union_mask)
        if rows.size == 0:
            raise ValueError(f"No finite pixels found in {path.name}")

        latitude_vector, longitude_vector = coordinate_vectors(src)
        latitude = latitude_vector[rows].astype(np.float32, copy=False)
        longitude = longitude_vector[cols].astype(np.float32, copy=False)
        stride = map_stride(int(rows.size), max_map_points)
        sample = (rows % stride == 0) & (cols % stride == 0)

        arrays: dict[str, pa.Array] = {
            "date": pa.array(np.full(rows.size, date_value, dtype="datetime64[ms]"), type=pa.timestamp("ms")),
            "latitude": pa.array(latitude, type=pa.float32()),
            "longitude": pa.array(longitude, type=pa.float32()),
            "elevation_m": pa.array(np.full(rows.size, 500.0, dtype=np.float32), type=pa.float32()),
        }
        band_names = unique_band_names(src.descriptions)
        valid_counts: dict[str, int] = {}
        for band_index, band_name in enumerate(band_names):
            values = data[band_index, rows, cols]
            band_valid = np.isfinite(values)
            valid_counts[band_name] = int(band_valid.sum())
            arrays[band_name] = pa.array(values, mask=~band_valid, type=pa.float32())
        arrays["_map_sample"] = pa.array(sample, type=pa.bool_())

        table = pa.table(arrays)
        source_meta = {
            "source_file": path.name,
            "source_crs": src.crs.to_string(),
            "source_width": src.width,
            "source_height": src.height,
            "source_transform": list(src.transform)[:6],
            "date": date_text,
            "row_count": table.num_rows,
            "map_sample_count": int(sample.sum()),
            "map_sample_stride": stride,
            "valid_counts": valid_counts,
        }
        metadata = dict(table.schema.metadata or {})
        metadata[b"mod10a1"] = json.dumps(source_meta, sort_keys=True).encode("utf-8")
        table = table.replace_schema_metadata(metadata)
        return table, source_meta


def verify_file(source: Path, output: Path) -> dict[str, Any]:
    _, expected_date = parse_date(source)
    with rasterio.open(source) as src:
        expected_rows = int(np.any(np.isfinite(src.read()), axis=0).sum())
        expected_bands = unique_band_names(src.descriptions)

    parquet = pq.ParquetFile(output)
    schema_names = parquet.schema_arrow.names
    expected_columns = ["date", "latitude", "longitude", "elevation_m", *expected_bands, "_map_sample"]
    if schema_names != expected_columns:
        raise RuntimeError(f"Column mismatch in {output.name}: {schema_names}")
    if parquet.metadata.num_rows != expected_rows:
        raise RuntimeError(
            f"Row mismatch in {output.name}: {parquet.metadata.num_rows} != {expected_rows}"
        )
    dates = pq.read_table(output, columns=["date"])["date"]
    unique_dates = dates.unique().to_pylist()
    if len(unique_dates) != 1 or np.datetime64(unique_dates[0], "ms") != expected_date:
        raise RuntimeError(f"Date mismatch in {output.name}: {unique_dates}")
    sample_count = int(
        pq.read_table(output, columns=["_map_sample"])["_map_sample"].to_numpy().sum()
    )
    return {"rows": expected_rows, "map_sample_count": sample_count, "columns": schema_names}


def convert_all(
    source_dir: Path,
    output_dir: Path,
    *,
    overwrite: bool,
    verify_only: bool,
    max_map_points: int,
    row_group_size: int,
) -> dict[str, Any]:
    sources = sorted([*source_dir.glob("*.tif"), *source_dir.glob("*.tiff")])
    if not sources:
        raise FileNotFoundError(f"No TIFF files found in {source_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict[str, Any]] = []
    for index, source in enumerate(sources, start=1):
        date_text, _ = parse_date(source)
        output = output_dir / f"{source.stem}.parquet"
        if verify_only or (output.exists() and not overwrite):
            if not output.exists():
                raise FileNotFoundError(f"Missing converted file: {output}")
            source_meta: dict[str, Any] = {"date": date_text}
            action = "verified"
        else:
            table, source_meta = raster_to_table(source, max_map_points)
            temporary = output.with_suffix(".parquet.tmp")
            pq.write_table(
                table,
                temporary,
                compression="zstd",
                compression_level=6,
                use_dictionary=["date", "elevation_m", "_map_sample"],
                write_statistics=True,
                row_group_size=row_group_size,
            )
            temporary.replace(output)
            action = "written"

        checks = verify_file(source, output)
        record = {
            "source": source.name,
            "output": output.name,
            "date": date_text,
            "rows": checks["rows"],
            "map_sample_count": checks["map_sample_count"],
            "size_bytes": output.stat().st_size,
            "status": action,
            **{key: value for key, value in source_meta.items() if key not in {"date", "row_count"}},
        }
        records.append(record)
        LOGGER.info(
            "[%d/%d] %s %s rows=%s preview=%s size=%.2f MiB",
            index,
            len(sources),
            action,
            output.name,
            f"{checks['rows']:,}",
            f"{checks['map_sample_count']:,}",
            output.stat().st_size / (1024 * 1024),
        )

    manifest = {
        "dataset": "mod10a1_monthly",
        "format": "parquet",
        "source_dir": str(source_dir.resolve()),
        "output_dir": str(output_dir.resolve()),
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "file_count": len(records),
        "total_rows": sum(record["rows"] for record in records),
        "total_size_bytes": sum(record["size_bytes"] for record in records),
        "max_map_points": max_map_points,
        "files": records,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    manifest = convert_all(
        args.source_dir.resolve(),
        args.output_dir.resolve(),
        overwrite=args.overwrite,
        verify_only=args.verify_only,
        max_map_points=args.max_map_points,
        row_group_size=args.row_group_size,
    )
    LOGGER.info(
        "Complete: files=%s rows=%s size=%.2f GiB",
        manifest["file_count"],
        f"{manifest['total_rows']:,}",
        manifest["total_size_bytes"] / (1024**3),
    )


if __name__ == "__main__":
    main()
