"""
Copy split parquet files (_H1/_H2) from a staging folder into the app dataset folder.

By default, existing complete years in target are not overwritten.
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync split parquet files into dataset folder.")
    parser.add_argument("--source-dir", type=Path, required=True, help="Folder containing *_H1.parquet/*_H2.parquet")
    parser.add_argument("--target-dir", type=Path, required=True, help="App dataset folder")
    parser.add_argument(
        "--overwrite-existing-files",
        action="store_true",
        help="Allow overwriting existing target files (default: skip)",
    )
    return parser.parse_args()


def get_year_from_name(name: str) -> int | None:
    match = YEAR_PATTERN.search(name)
    if not match:
        return None
    return int(match.group(0))


def collect_complete_years(target_dir: Path) -> set[int]:
    halves_by_year: dict[int, set[str]] = {}
    for file_path in target_dir.glob("*_H[12].parquet"):
        year = get_year_from_name(file_path.stem)
        if year is None:
            continue
        half = "H1" if file_path.stem.endswith("_H1") else "H2"
        halves_by_year.setdefault(year, set()).add(half)

    return {year for year, halves in halves_by_year.items() if {"H1", "H2"}.issubset(halves)}


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.resolve()
    target_dir = args.target_dir.resolve()

    if not source_dir.exists():
        raise FileNotFoundError(f"Source folder not found: {source_dir}")
    if not target_dir.exists():
        raise FileNotFoundError(f"Target folder not found: {target_dir}")

    split_files = sorted(source_dir.glob("*_H[12].parquet"))
    if not split_files:
        print(f"No split parquet files found in {source_dir}")
        return

    complete_years = collect_complete_years(target_dir)
    copied = 0
    skipped = 0

    for src_file in split_files:
        year = get_year_from_name(src_file.stem)
        if year is None:
            skipped += 1
            continue

        dest_file = target_dir / src_file.name
        if not args.overwrite_existing_files:
            if dest_file.exists():
                skipped += 1
                continue
            if year in complete_years:
                skipped += 1
                continue

        shutil.copy2(src_file, dest_file)
        copied += 1

    print(f"Source split files: {len(split_files)}")
    print(f"Copied: {copied}")
    print(f"Skipped: {skipped}")


if __name__ == "__main__":
    main()
