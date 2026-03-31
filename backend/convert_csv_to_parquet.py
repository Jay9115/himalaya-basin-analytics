"""
Generic CSV -> Parquet converter for local dataset folders.
Works for ERA5 and CMIP6 schema variants.
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Optional

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent.parent
DEFAULT_SOURCE_DIR = ROOT_DIR / "ERA5_Upper_Indus"
SKIP_COLUMNS = {"system:index", ".geo"}
DATE_COLUMNS = {"date", "Date", "DATE"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert dataset CSV files to Parquet.")
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help=f"Folder containing CSV files (default: {DEFAULT_SOURCE_DIR})",
    )
    parser.add_argument(
        "--pattern",
        default="*.csv",
        help="CSV filename pattern (default: *.csv)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing parquet files",
    )
    parser.add_argument(
        "--chunksize",
        type=int,
        default=200_000,
        help="Rows per CSV chunk while converting (default: 200000)",
    )
    return parser.parse_args()


def is_empty_csv(csv_file: Path) -> bool:
    # A few CMIP year files are 2-byte placeholders.
    if csv_file.stat().st_size <= 5:
        return True
    return False


def parse_date_column(series: pd.Series, column_name: str) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="raise")

    series_as_str = series.astype("string")
    missing_mask = series_as_str.isna() | (series_as_str.str.strip() == "")
    parsed = pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")
    non_empty_values = series_as_str[~missing_mask]
    if non_empty_values.empty:
        return parsed

    try:
        try:
            parsed_non_empty = pd.to_datetime(non_empty_values, errors="raise", format="mixed")
        except TypeError:
            parsed_non_empty = pd.to_datetime(non_empty_values, errors="raise")
    except Exception as exc:
        sample_values = non_empty_values.head(3).tolist()
        raise ValueError(
            f"Invalid date values found in column '{column_name}'. Sample values: {sample_values}"
        ) from exc

    parsed.loc[~missing_mask] = parsed_non_empty.values
    return parsed


def optimize_chunk(chunk: pd.DataFrame) -> pd.DataFrame:
    for column in chunk.columns:
        if column in DATE_COLUMNS:
            chunk[column] = parse_date_column(chunk[column], column)
            continue
        if column in SKIP_COLUMNS:
            continue

        # Convert truly numeric columns while preserving full precision.
        original_non_null = chunk[column].notna().sum()
        numeric = pd.to_numeric(chunk[column], errors="coerce")
        numeric_non_null = numeric.notna().sum()
        if original_non_null > 0 and numeric_non_null == original_non_null:
            chunk[column] = numeric
    return chunk


def convert_csv_to_parquet(
    csv_file: Path,
    output_dir: Path,
    overwrite: bool = False,
    chunksize: int = 200_000,
) -> bool:
    output_file = output_dir / f"{csv_file.stem}.parquet"
    if output_file.exists() and not overwrite:
        logger.info(f"Skipping {csv_file.name} (parquet already exists)")
        return True

    if is_empty_csv(csv_file):
        logger.warning(f"Skipping {csv_file.name} (empty placeholder file)")
        return False

    logger.info(f"Converting {csv_file.name}")
    writer: Optional[pq.ParquetWriter] = None
    total_rows = 0
    try:
        for idx, chunk in enumerate(pd.read_csv(csv_file, chunksize=chunksize)):
            chunk = optimize_chunk(chunk)
            logger.info(f"  chunk {idx + 1}: {len(chunk):,} rows")
            if chunk.empty:
                continue

            table = pa.Table.from_pandas(chunk, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(str(output_file), table.schema, compression="snappy")
            writer.write_table(table)
            total_rows += len(chunk)

        if writer is None:
            logger.warning(f"Skipping {csv_file.name} (no rows)")
            return False

        writer.close()
        writer = None

        csv_size = csv_file.stat().st_size / (1024 ** 2)
        parquet_size = output_file.stat().st_size / (1024 ** 2)
        reduction = (1 - parquet_size / csv_size) * 100 if csv_size > 0 else 0
        logger.info(
            f"Done {csv_file.name}: {csv_size:.2f} MB -> {parquet_size:.2f} MB "
            f"({reduction:.1f}% smaller), rows={total_rows:,}"
        )
        return True
    except Exception as exc:
        logger.error(f"Error converting {csv_file.name}: {exc}")
        if output_file.exists():
            output_file.unlink(missing_ok=True)
        return False
    finally:
        if writer is not None:
            writer.close()


def convert_all(source_dir: Path, pattern: str, overwrite: bool, chunksize: int) -> None:
    source_dir = source_dir.resolve()
    logger.info("=" * 72)
    logger.info("CSV to Parquet Conversion")
    logger.info(f"Source: {source_dir}")
    logger.info(f"Pattern: {pattern}")
    logger.info(f"Chunk size: {chunksize:,}")
    logger.info("=" * 72)

    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")

    csv_files = sorted(source_dir.glob(pattern))
    if not csv_files:
        logger.warning("No CSV files found")
        return

    success_count = 0
    skipped_count = 0
    for idx, csv_file in enumerate(csv_files, start=1):
        logger.info(f"[{idx}/{len(csv_files)}] {csv_file.name}")
        ok = convert_csv_to_parquet(
            csv_file,
            source_dir,
            overwrite=overwrite,
            chunksize=chunksize,
        )
        if ok:
            success_count += 1
        else:
            skipped_count += 1

    parquet_files = list(source_dir.glob("*.parquet"))
    total_mb = sum(file_path.stat().st_size for file_path in parquet_files) / (1024 ** 2)

    logger.info("=" * 72)
    logger.info(
        f"Completed. converted_or_exists={success_count}, skipped={skipped_count}, "
        f"total_parquet={len(parquet_files)}, total_size_mb={total_mb:.2f}"
    )
    logger.info("=" * 72)


if __name__ == "__main__":
    args = parse_args()
    convert_all(args.source_dir, args.pattern, args.overwrite, args.chunksize)
