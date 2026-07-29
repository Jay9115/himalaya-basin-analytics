"""
Convert SPHY GeoTIFF layers into parquet files shaped for the webapp backend.

Input expectation:
- filenames like GMel_20110715.tif and SMel_20110715.tif
- same grid / CRS for all variables of the same date

Output schema per date:
- date (timestamp)
- latitude (float64)
- longitude (float64)
- one column per raster variable, e.g. GMel / SMel
"""

from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio
from rasterio.transform import xy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).resolve().parent
INPUT_DIR_PATH = SCRIPT_DIR / "input"
OUTPUT_DIR_PATH = SCRIPT_DIR / "output"

DEFAULT_SOURCE_DIR = INPUT_DIR_PATH
DEFAULT_OUTPUT_DIR = OUTPUT_DIR_PATH
FILENAME_PATTERN = "*.tif"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert SPHY GeoTIFF layers to parquet."
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help=f"Folder containing SPHY GeoTIFF files (default: {DEFAULT_SOURCE_DIR})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output folder for parquet files (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing parquet files",
    )
    parser.add_argument(
        "--valid-mode",
        choices=("intersection", "union"),
        default="intersection",
        help=(
            "How to combine valid-data masks across variables for the same date. "
            "'intersection' keeps only pixels valid in all variables. "
            "'union' keeps any valid pixel and may create NaNs in some variable columns."
        ),
    )
    return parser.parse_args()


def parse_filename(tif_path: Path) -> Tuple[str, str]:
    parts = tif_path.stem.split("_")
    if len(parts) != 2:
        raise ValueError(
            f"Unexpected filename '{tif_path.name}'. "
            "Expected format like GMel_20110715.tif"
        )

    variable, date_token = parts

    if len(date_token) != 8 or not date_token.isdigit():
        raise ValueError(
            f"Unexpected date token '{date_token}' in '{tif_path.name}'. "
            "Expected YYYYMMDD."
        )

    return variable, date_token


def discover_files(source_dir: Path) -> Dict[str, Dict[str, Path]]:
    grouped: Dict[str, Dict[str, Path]] = defaultdict(dict)

    tif_files = sorted(source_dir.glob(FILENAME_PATTERN))
    if not tif_files:
        raise FileNotFoundError(f"No GeoTIFF files found in {source_dir}")

    for tif_path in tif_files:
        variable, date_token = parse_filename(tif_path)
        grouped[date_token][variable] = tif_path

    return dict(grouped)


def validate_group(date_token: str, variable_files: Dict[str, Path]) -> None:
    refs = list(variable_files.items())

    if not refs:
        raise ValueError(f"No files found for date {date_token}")

    with rasterio.open(refs[0][1]) as ref_src:
        ref_shape = (ref_src.height, ref_src.width)
        ref_transform = ref_src.transform
        ref_crs = ref_src.crs

    for variable, tif_path in refs[1:]:
        with rasterio.open(tif_path) as src:
            same_grid = (
                src.height == ref_shape[0]
                and src.width == ref_shape[1]
                and src.transform == ref_transform
                and src.crs == ref_crs
            )

        if not same_grid:
            raise ValueError(
                f"Grid mismatch for date {date_token}: "
                f"'{tif_path.name}' does not match '{refs[0][1].name}'"
            )


def build_common_mask(
    arrays: Dict[str, np.ma.MaskedArray],
    valid_mode: str,
) -> np.ndarray:
    masks = [~array.mask for array in arrays.values()]

    if valid_mode == "union":
        return np.logical_or.reduce(masks)

    return np.logical_and.reduce(masks)


def convert_group_to_frame(
    date_token: str,
    variable_files: Dict[str, Path],
    valid_mode: str,
) -> pd.DataFrame:
    validate_group(date_token, variable_files)

    arrays: Dict[str, np.ma.MaskedArray] = {}
    transform = None
    crs = None
    height = 0
    width = 0

    for variable, tif_path in sorted(variable_files.items()):
        with rasterio.open(tif_path) as src:
            arrays[variable] = src.read(1, masked=True)
            transform = src.transform
            crs = src.crs
            height = src.height
            width = src.width

    if transform is None:
        raise ValueError(
            f"Could not read raster transform for date {date_token}"
        )

    valid_mask = build_common_mask(arrays, valid_mode)

    valid_rows, valid_cols = np.where(valid_mask)

    if valid_rows.size == 0:
        raise ValueError(f"No valid pixels found for date {date_token}")

    longitudes, latitudes = xy(
        transform,
        valid_rows,
        valid_cols,
        offset="center",
    )

    frame = pd.DataFrame(
        {
            "date": pd.to_datetime(date_token, format="%Y%m%d"),
            "latitude": np.asarray(latitudes, dtype=np.float64),
            "longitude": np.asarray(longitudes, dtype=np.float64),
        }
    )

    for variable, array in sorted(arrays.items()):
        values = array.data[
            valid_rows,
            valid_cols,
        ].astype(np.float64, copy=False)

        if valid_mode == "union":
            variable_valid = ~array.mask[valid_rows, valid_cols]
            values = values.copy()
            values[~variable_valid] = np.nan

        frame[variable] = values

    frame.attrs["crs"] = str(crs)
    frame.attrs["height"] = height
    frame.attrs["width"] = width
    frame.attrs["valid_mode"] = valid_mode

    return frame


def write_frame_to_parquet(
    frame: pd.DataFrame,
    output_file: Path,
) -> None:
    table = pa.Table.from_pandas(frame, preserve_index=False)

    metadata = dict(table.schema.metadata or {})

    for key, value in frame.attrs.items():
        metadata[f"sphy_{key}".encode()] = str(value).encode()

    table = table.replace_schema_metadata(metadata)

    pq.write_table(
        table,
        output_file,
        compression="snappy",
    )


def convert_all(
    source_dir: Path,
    output_dir: Path,
    overwrite: bool,
    valid_mode: str,
) -> List[Path]:
    grouped = discover_files(source_dir)

    output_dir.mkdir(parents=True, exist_ok=True)

    written: List[Path] = []

    logger.info("=" * 72)
    logger.info("SPHY GeoTIFF to Parquet Conversion")
    logger.info("Source: %s", source_dir.resolve())
    logger.info("Output: %s", output_dir.resolve())
    logger.info("Dates discovered: %d", len(grouped))
    logger.info("Valid mode: %s", valid_mode)
    logger.info("=" * 72)

    for idx, (date_token, variable_files) in enumerate(
        sorted(grouped.items()),
        start=1,
    ):
        output_file = output_dir / f"SPHY_{date_token}.parquet"

        if output_file.exists() and not overwrite:
            logger.info(
                "[%d/%d] Skipping %s (already exists)",
                idx,
                len(grouped),
                output_file.name,
            )
            written.append(output_file)
            continue

        logger.info(
            "[%d/%d] Converting %s with variables: %s",
            idx,
            len(grouped),
            date_token,
            ", ".join(sorted(variable_files)),
        )

        frame = convert_group_to_frame(
            date_token=date_token,
            variable_files=variable_files,
            valid_mode=valid_mode,
        )

        write_frame_to_parquet(frame, output_file)

        written.append(output_file)

        logger.info(
            "  wrote %s: rows=%s, columns=%s",
            output_file.name,
            f"{len(frame):,}",
            ", ".join(frame.columns),
        )

    logger.info("=" * 72)
    logger.info("Completed. parquet_files=%d", len(written))
    logger.info("=" * 72)

    return written


def main() -> None:
    args = parse_args()

    source_dir = args.source_dir.resolve()
    output_dir = args.output_dir.resolve()

    convert_all(
        source_dir=source_dir,
        output_dir=output_dir,
        overwrite=args.overwrite,
        valid_mode=args.valid_mode,
    )


if __name__ == "__main__":
    main()