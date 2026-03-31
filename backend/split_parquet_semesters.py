"""
Split yearly parquet files into 6-month parquet files (H1/H2) without changing values.

For each input file:
  <name>.parquet -> <name>_H1.parquet (Jan-Jun) + <name>_H2.parquet (Jul-Dec)

Original yearly files are moved to a backup folder so the app does not read duplicates.
"""

from __future__ import annotations

import argparse
import gc
import shutil
from pathlib import Path
from typing import Iterable

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


DATE_CANDIDATES = ("date", "Date", "DATE")


def detect_date_column(columns: Iterable[str]) -> str:
    for name in DATE_CANDIDATES:
        if name in columns:
            return name
    raise ValueError(f"Could not detect date column. Available columns: {list(columns)}")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def safe_unlink(path: Path) -> None:
    if path.exists():
        path.unlink()


def semester_masks(date_array: pa.Array) -> tuple[pa.Array, pa.Array]:
    months = pc.month(date_array)
    h1 = pc.less_equal(months, pa.scalar(6, months.type))
    h2 = pc.greater_equal(months, pa.scalar(7, months.type))
    return h1, h2


def split_file(file_path: Path, backup_dir: Path, batch_size: int) -> None:
    stem = file_path.stem
    if stem.endswith("_H1") or stem.endswith("_H2"):
        return

    pf = pq.ParquetFile(file_path)
    date_col = detect_date_column(pf.schema.names)
    schema = pf.schema_arrow
    total_rows = pf.metadata.num_rows

    out_h1 = file_path.with_name(f"{stem}_H1.parquet")
    out_h2 = file_path.with_name(f"{stem}_H2.parquet")
    tmp_h1 = out_h1.with_suffix(".parquet.tmp")
    tmp_h2 = out_h2.with_suffix(".parquet.tmp")

    if out_h1.exists() or out_h2.exists():
        raise RuntimeError(
            f"Output already exists for {file_path.name}. "
            f"Please remove {out_h1.name}/{out_h2.name} first."
        )

    safe_unlink(tmp_h1)
    safe_unlink(tmp_h2)

    h1_rows = 0
    h2_rows = 0

    print(f"[split] {file_path.name} ({total_rows:,} rows)")

    writer_h1 = pq.ParquetWriter(tmp_h1, schema=schema, compression="snappy")
    writer_h2 = pq.ParquetWriter(tmp_h2, schema=schema, compression="snappy")
    try:
        for batch in pf.iter_batches(batch_size=batch_size):
            table = pa.Table.from_batches([batch], schema=schema)
            h1_mask, h2_mask = semester_masks(table[date_col])

            t_h1 = table.filter(h1_mask)
            if t_h1.num_rows:
                writer_h1.write_table(t_h1)
                h1_rows += t_h1.num_rows

            t_h2 = table.filter(h2_mask)
            if t_h2.num_rows:
                writer_h2.write_table(t_h2)
                h2_rows += t_h2.num_rows
    finally:
        writer_h1.close()
        writer_h2.close()

    if (h1_rows + h2_rows) != total_rows:
        safe_unlink(tmp_h1)
        safe_unlink(tmp_h2)
        raise RuntimeError(
            f"Row mismatch for {file_path.name}: "
            f"H1({h1_rows}) + H2({h2_rows}) != total({total_rows})"
        )

    # Ensure parquet file handle is released before moving original file on Windows.
    if hasattr(pf, "close"):
        pf.close()
    del pf
    gc.collect()

    ensure_dir(backup_dir)
    backup_file = backup_dir / file_path.name
    if backup_file.exists():
        raise RuntimeError(f"Backup file already exists: {backup_file}")

    shutil.move(str(file_path), str(backup_file))
    tmp_h1.rename(out_h1)
    tmp_h2.rename(out_h2)

    print(
        f"       -> {out_h1.name} ({h1_rows:,} rows), "
        f"{out_h2.name} ({h2_rows:,} rows), "
        f"backup: {backup_file.name}"
    )


def split_dataset(dataset_dir: Path, backup_name: str, batch_size: int) -> None:
    if not dataset_dir.exists():
        raise FileNotFoundError(f"Dataset folder not found: {dataset_dir}")

    backup_dir = dataset_dir / backup_name
    parquet_files = sorted(
        p for p in dataset_dir.glob("*.parquet") if not p.stem.endswith("_H1") and not p.stem.endswith("_H2")
    )

    if not parquet_files:
        print(f"[skip] No yearly parquet files found in {dataset_dir}")
        return

    print(f"\n=== Dataset: {dataset_dir} ===")
    print(f"Files to split: {len(parquet_files)}")

    for file_path in parquet_files:
        split_file(file_path, backup_dir=backup_dir, batch_size=batch_size)

    print(f"[done] {dataset_dir}")
    print(f"       Backup folder: {backup_dir}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Split yearly parquet files into H1/H2 parquet files.")
    parser.add_argument(
        "--dataset-dir",
        action="append",
        required=True,
        help="Dataset folder path containing yearly parquet files. Use twice for ERA5 and CMIP6.",
    )
    parser.add_argument(
        "--backup-name",
        default="_yearly_backup",
        help="Backup subfolder name created inside each dataset directory.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=250_000,
        help="Batch size for Arrow iteration.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    for dataset in args.dataset_dir:
        split_dataset(Path(dataset), backup_name=args.backup_name, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
