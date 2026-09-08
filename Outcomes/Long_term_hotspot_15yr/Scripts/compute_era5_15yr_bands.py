"""Build the 15-year ERA5 + CHIRPS long-term hotspot outcome.

The 1951-2025 record is split into five complete 15-year bands. Snow-related
variables and precipitation are summed within each band; all other variables
are averaged. Results are saved beside this script under ``../Outputs``.

Run from any directory:
    python Outcomes/Long_term_hotspot_15yr/Scripts/compute_era5_15yr_bands.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import calendar
import json
import os
import re
import argparse
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


ROOT_DIR = Path(__file__).resolve().parents[3]
SOURCE_DIR = Path(os.environ.get("ERA5_SOURCE_DIR", ROOT_DIR / "Database" / "Full_Shape_ERA5"))
CHIRPS_SOURCE_DIR = Path(os.environ.get("CHIRPS_SOURCE_DIR", ROOT_DIR / "Database" / "Chirps"))
CHIRPS_FALLBACK_DIR = Path(
    os.environ.get("CHIRPS_FALLBACK_DIR", ROOT_DIR.parents[1] / "Database_backup" / "CHIRPS_V2")
)
OUTPUT_DIR = ROOT_DIR / "Outcomes" / "Long_term_hotspot_15yr" / "Outputs"
OUTPUT_PARQUET = OUTPUT_DIR / "long_term_hotspot_15yr_band_values.parquet"
OUTPUT_META = OUTPUT_DIR / "long_term_hotspot_15yr_metadata.json"

EXCLUDE_COLUMNS = {"system:index", ".geo"}
DATE_CANDIDATES = ["date", "Date", "DATE"]
LAT_CANDIDATES = ["latitude", "lat", "Latitude", "Lat"]
LON_CANDIDATES = ["longitude", "lon", "Longitude", "Lon"]
ELEV_CANDIDATES = ["elevation_m", "elev", "elevation", "Elevation_m"]
YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")
HALF_YEAR_PATTERN = re.compile(r"((?:19|20)\d{2})_H([12])", re.IGNORECASE)

BANDS = [
    {"id": "1951_1965", "label": "1951-1965", "start_year": 1951, "end_year": 1965},
    {"id": "1966_1980", "label": "1966-1980", "start_year": 1966, "end_year": 1980},
    {"id": "1981_1995", "label": "1981-1995", "start_year": 1981, "end_year": 1995},
    {"id": "1996_2010", "label": "1996-2010", "start_year": 1996, "end_year": 2010},
    {"id": "2011_2025", "label": "2011-2025", "start_year": 2011, "end_year": 2025},
]


def pick_column(columns: List[str], candidates: List[str], field_name: str) -> str:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    raise RuntimeError(f"Could not detect {field_name} column. Columns: {columns}")


def parse_datetime_series(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="raise")
    try:
        return pd.to_datetime(series, errors="raise", format="mixed")
    except TypeError:
        return pd.to_datetime(series, errors="raise")


def extract_years_from_filename(file_path: Path) -> List[int]:
    return sorted({int(match) for match in YEAR_PATTERN.findall(file_path.stem)})


def select_files_for_band(files: List[Path], start_year: int, end_year: int) -> List[Path]:
    selected: List[Path] = []
    for file_path in files:
        years = extract_years_from_filename(file_path)
        if not years or not (max(years) < start_year or min(years) > end_year):
            selected.append(file_path)
    return selected


def detect_schema(file_path: Path) -> Tuple[str, str, str, str, List[str]]:
    columns = list(pq.ParquetFile(file_path).schema.names)
    date_col = pick_column(columns, DATE_CANDIDATES, "date")
    lat_col = pick_column(columns, LAT_CANDIDATES, "latitude")
    lon_col = pick_column(columns, LON_CANDIDATES, "longitude")
    elev_col = pick_column(columns, ELEV_CANDIDATES, "elevation")
    base_cols = {date_col, lat_col, lon_col, elev_col}
    variables = sorted(c for c in columns if c not in EXCLUDE_COLUMNS and c not in base_cols)
    if not variables:
        raise RuntimeError("No data variables found after excluding coordinates and date.")
    return date_col, lat_col, lon_col, elev_col, variables


def days_in_half_year(year: int, half: int) -> int:
    months = range(1, 7) if half == 1 else range(7, 13)
    return sum(calendar.monthrange(year, month)[1] for month in months)


def expected_rows_for_file(file_path: Path, point_count: int) -> int | None:
    match = HALF_YEAR_PATTERN.search(file_path.stem)
    if not match:
        return None
    return days_in_half_year(int(match.group(1)), int(match.group(2))) * point_count


def choose_chirps_files(
    primary_files: List[Path], fallback_dir: Path
) -> Tuple[List[Path], List[Dict[str, object]], List[Dict[str, object]]]:
    """Replace truncated/duplicated primary files with verified complete fallbacks."""
    first_match = HALF_YEAR_PATTERN.search(primary_files[0].stem)
    if not first_match:
        return primary_files, [], []
    first_days = days_in_half_year(int(first_match.group(1)), int(first_match.group(2)))
    primary_point_count = pq.ParquetFile(primary_files[0]).metadata.num_rows // first_days

    fallback_point_count: int | None = None
    fallback_first = fallback_dir / primary_files[0].name
    if fallback_first.exists():
        fallback_point_count = pq.ParquetFile(fallback_first).metadata.num_rows // first_days

    selected: List[Path] = []
    replacements: List[Dict[str, object]] = []
    deduplications: List[Dict[str, object]] = []
    for primary in primary_files:
        primary_rows = pq.ParquetFile(primary).metadata.num_rows
        primary_expected = expected_rows_for_file(primary, primary_point_count)
        if primary_expected is None or primary_rows == primary_expected:
            selected.append(primary)
            continue
        if primary_expected and primary_rows > primary_expected and primary_rows % primary_expected == 0:
            selected.append(primary)
            deduplications.append(
                {
                    "file": primary.name,
                    "primary_rows": int(primary_rows),
                    "expected_rows_after_deduplication": int(primary_expected),
                    "duplicate_factor": int(primary_rows // primary_expected),
                }
            )
            continue

        fallback = fallback_dir / primary.name
        fallback_rows = pq.ParquetFile(fallback).metadata.num_rows if fallback.exists() else None
        fallback_expected = (
            expected_rows_for_file(fallback, fallback_point_count)
            if fallback.exists() and fallback_point_count is not None
            else None
        )
        if fallback_rows is not None and fallback_rows == fallback_expected:
            selected.append(fallback)
            replacements.append(
                {
                    "file": primary.name,
                    "primary_rows": int(primary_rows),
                    "expected_primary_rows": int(primary_expected),
                    "fallback_rows": int(fallback_rows),
                    "fallback_path": str(fallback),
                }
            )
        else:
            raise RuntimeError(
                f"Invalid CHIRPS file {primary.name}: rows={primary_rows}, expected={primary_expected}; "
                "no complete fallback is available."
            )
    return selected, replacements, deduplications


def aggregation_for(variable: str) -> str:
    """Use totals for precipitation/snow and temporal means otherwise."""
    normalized = variable.lower()
    if "precip" in normalized or "snow" in normalized or normalized.startswith("swe"):
        return "sum"
    return "mean"


def aggregate_band(
    files: List[Path],
    band: Dict[str, object],
    date_col: str,
    lat_col: str,
    lon_col: str,
    elev_col: str,
    variables: List[str],
    source_dataset: str,
    variable_output_names: Dict[str, str] | None = None,
    minimum_sample_fraction: float = 0.0,
    deduplicate_files: set[str] | None = None,
) -> pd.DataFrame:
    start_year = int(band["start_year"])
    end_year = int(band["end_year"])
    start_ts = datetime(start_year, 1, 1)
    end_ts = datetime(end_year, 12, 31)
    requested_columns = [date_col, lat_col, lon_col, elev_col] + variables
    accumulator: pd.DataFrame | None = None
    processed_rows = 0
    t0 = time.time()

    for idx, file_path in enumerate(files, start=1):
        filters = [(date_col, ">=", start_ts), (date_col, "<=", end_ts)]
        try:
            table = pq.read_table(str(file_path), columns=requested_columns, filters=filters)
        except Exception:
            table = pq.read_table(str(file_path), columns=requested_columns)
        if table.num_rows == 0:
            continue

        df = table.to_pandas()
        if deduplicate_files and file_path.name in deduplicate_files:
            rows_before = len(df)
            df = df.drop_duplicates(ignore_index=True)
            print(
                f"[{band['label']}] {file_path.name}: deduplicated {rows_before:,} -> {len(df):,} rows",
                flush=True,
            )
        parsed_dates = parse_datetime_series(df[date_col])
        year_mask = (parsed_dates.dt.year >= start_year) & (parsed_dates.dt.year <= end_year)
        if not year_mask.any():
            continue

        scoped = df.loc[year_mask, [lat_col, lon_col, elev_col] + variables].copy()
        for column in [lat_col, lon_col, elev_col] + variables:
            scoped[column] = pd.to_numeric(scoped[column], errors="coerce")
        scoped = scoped.dropna(subset=[lat_col, lon_col])
        if scoped.empty:
            continue

        grouped_obj = scoped.groupby([lat_col, lon_col], sort=False, observed=True)
        grouped_data: Dict[str, pd.Series] = {
            "elev_sum": grouped_obj[elev_col].sum(min_count=1),
            "elev_count": grouped_obj[elev_col].count(),
        }
        for variable in variables:
            grouped_data[f"{variable}_sum"] = grouped_obj[variable].sum(min_count=1)
            grouped_data[f"{variable}_count"] = grouped_obj[variable].count()

        grouped = pd.DataFrame(grouped_data)
        accumulator = grouped if accumulator is None else accumulator.add(grouped, fill_value=0)
        processed_rows += int(scoped.shape[0])
        print(
            f"[{band['label']}] {idx}/{len(files)} {file_path.name}: "
            f"rows={scoped.shape[0]:,}, points={grouped.shape[0]:,}, elapsed={time.time()-t0:.1f}s",
            flush=True,
        )

    output_columns = [
        "band_id", "band_label", "start_year", "end_year", "variable",
        "source_dataset", "aggregation", "lat", "lon", "elev", "value", "sample_count",
    ]
    if accumulator is None or accumulator.empty:
        return pd.DataFrame(columns=output_columns)

    accumulator = accumulator.fillna(0).reset_index()
    elev_count = pd.to_numeric(accumulator["elev_count"], errors="coerce")
    elev_mean = pd.to_numeric(accumulator["elev_sum"], errors="coerce") / elev_count.replace({0: np.nan})
    long_frames: List[pd.DataFrame] = []

    for variable in variables:
        output_variable = (variable_output_names or {}).get(variable, variable)
        aggregation = aggregation_for(output_variable)
        var_sum = pd.to_numeric(accumulator[f"{variable}_sum"], errors="coerce")
        var_count = pd.to_numeric(accumulator[f"{variable}_count"], errors="coerce")
        value = var_sum if aggregation == "sum" else var_sum / var_count.replace({0: np.nan})
        frame = pd.DataFrame(
            {
                "band_id": str(band["id"]),
                "band_label": str(band["label"]),
                "start_year": start_year,
                "end_year": end_year,
                "variable": output_variable,
                "source_dataset": source_dataset,
                "aggregation": aggregation,
                "lat": pd.to_numeric(accumulator[lat_col], errors="coerce"),
                "lon": pd.to_numeric(accumulator[lon_col], errors="coerce"),
                "elev": elev_mean,
                "value": value,
                "sample_count": var_count.astype("Int64"),
            }
        ).dropna(subset=["lat", "lon", "value"])
        if minimum_sample_fraction > 0 and not frame.empty:
            minimum_count = float(frame["sample_count"].max()) * minimum_sample_fraction
            frame = frame[frame["sample_count"] >= minimum_count].copy()
        long_frames.append(frame)

    result = pd.concat(long_frames, ignore_index=True)
    result["sample_count"] = result["sample_count"].fillna(0).astype(int)
    print(
        f"[{band['label']}] complete: rows={result.shape[0]:,}, "
        f"processed_rows={processed_rows:,}, elapsed={time.time()-t0:.1f}s",
        flush=True,
    )
    return result[output_columns]


def main(reuse_era5: bool = False) -> None:
    if not SOURCE_DIR.exists():
        raise SystemExit(f"ERA5 source folder not found: {SOURCE_DIR}")
    parquet_files = sorted(SOURCE_DIR.glob("*.parquet"))
    if not parquet_files:
        raise SystemExit(f"No parquet files found in: {SOURCE_DIR}")
    if not CHIRPS_SOURCE_DIR.exists():
        raise SystemExit(f"CHIRPS source folder not found: {CHIRPS_SOURCE_DIR}")
    chirps_primary_files = sorted(CHIRPS_SOURCE_DIR.glob("*.parquet"))
    if not chirps_primary_files:
        raise SystemExit(f"No CHIRPS parquet files found in: {CHIRPS_SOURCE_DIR}")
    chirps_files, chirps_file_replacements, chirps_file_deduplications = choose_chirps_files(
        chirps_primary_files, CHIRPS_FALLBACK_DIR
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    date_col, lat_col, lon_col, elev_col, variables = detect_schema(parquet_files[0])
    era5_variables = variables
    era5_available_years = sorted(
        {year for file_path in parquet_files for year in extract_years_from_filename(file_path)}
    )
    era5_coverage_by_band = []
    for band in BANDS:
        expected_years = list(range(int(band["start_year"]), int(band["end_year"]) + 1))
        band_available_years = [year for year in expected_years if year in era5_available_years]
        era5_coverage_by_band.append(
            {
                "band_id": band["id"],
                "available_years": band_available_years,
                "missing_years": [year for year in expected_years if year not in era5_available_years],
            }
        )
    print(f"Source: {SOURCE_DIR}", flush=True)
    print(f"Files: {len(parquet_files)}", flush=True)

    run_start = time.time()
    output_frames: List[pd.DataFrame] = []
    if reuse_era5 and OUTPUT_PARQUET.exists():
        existing = pd.read_parquet(OUTPUT_PARQUET)
        if "source_dataset" not in existing.columns:
            raise SystemExit("Existing output cannot be reused because source_dataset is missing.")
        existing_era5 = existing[existing["source_dataset"] == "ERA5-Land"].copy()
        if existing_era5.empty:
            raise SystemExit("Existing output does not contain reusable ERA5-Land rows.")
        output_frames.append(existing_era5)
        print(f"Reusing {len(existing_era5):,} saved ERA5-Land rows", flush=True)
    else:
        for band in BANDS:
            selected_files = select_files_for_band(
                parquet_files, int(band["start_year"]), int(band["end_year"])
            )
            print(f"\nProcessing {band['label']} ({len(selected_files)} files)", flush=True)
            output_frames.append(
                aggregate_band(
                    selected_files, band, date_col, lat_col, lon_col, elev_col, variables,
                    source_dataset="ERA5-Land",
                )
            )

    chirps_date_col, chirps_lat_col, chirps_lon_col, chirps_elev_col, chirps_variables = detect_schema(chirps_files[0])
    precipitation_candidates = [variable for variable in chirps_variables if "precip" in variable.lower()]
    if len(precipitation_candidates) != 1:
        raise SystemExit(
            f"Expected one CHIRPS precipitation variable, found: {chirps_variables}"
        )
    chirps_raw_variable = precipitation_candidates[0]
    chirps_variable = "CHIRPS_precipitation_mm"
    chirps_variable_names = {chirps_raw_variable: chirps_variable}
    chirps_available_years = sorted(
        {year for file_path in chirps_files for year in extract_years_from_filename(file_path) if year <= 2025}
    )
    chirps_coverage_by_band = []
    for band in BANDS:
        expected_years = list(range(int(band["start_year"]), int(band["end_year"]) + 1))
        chirps_coverage_by_band.append(
            {
                "band_id": band["id"],
                "available_years": [year for year in expected_years if year in chirps_available_years],
                "missing_years": [year for year in expected_years if year not in chirps_available_years],
            }
        )

    print(f"\nCHIRPS source: {CHIRPS_SOURCE_DIR}", flush=True)
    print(f"CHIRPS files: {len(chirps_files)}", flush=True)
    if chirps_file_replacements:
        print(f"CHIRPS fallback replacements: {len(chirps_file_replacements)}", flush=True)
        for replacement in chirps_file_replacements:
            print(f"  {replacement['file']} -> {replacement['fallback_path']}", flush=True)
    if chirps_file_deduplications:
        print(f"CHIRPS files requiring deduplication: {len(chirps_file_deduplications)}", flush=True)
    for band in BANDS:
        selected_files = select_files_for_band(
            chirps_files, int(band["start_year"]), int(band["end_year"])
        )
        print(f"\nProcessing CHIRPS {band['label']} ({len(selected_files)} files)", flush=True)
        if not selected_files:
            continue
        output_frames.append(
            aggregate_band(
                selected_files,
                band,
                chirps_date_col,
                chirps_lat_col,
                chirps_lon_col,
                chirps_elev_col,
                [chirps_raw_variable],
                source_dataset="CHIRPS",
                variable_output_names=chirps_variable_names,
                minimum_sample_fraction=0.9,
                deduplicate_files={item["file"] for item in chirps_file_deduplications},
            )
        )

    final_df = pd.concat(output_frames, ignore_index=True)
    final_df = final_df.sort_values(["variable", "band_id", "lat", "lon"], ignore_index=True)
    final_df.to_parquet(OUTPUT_PARQUET, index=False)

    output_variables = era5_variables + [chirps_variable]
    aggregation_by_variable = {variable: aggregation_for(variable) for variable in output_variables}
    coverage_by_variable = {
        **{variable: era5_coverage_by_band for variable in era5_variables},
        chirps_variable: chirps_coverage_by_band,
    }
    metadata = {
        "outcome_id": "long_term_hotspot_15yr",
        "outcome_label": "Long Term Hotspot Analysis - 15 Year Bands",
        "description": "Five 15-year ERA5-Land and CHIRPS bands; precipitation and snow variables use sums, other variables use means.",
        "dataset": "era5_chirps",
        "source_paths": {"ERA5-Land": str(SOURCE_DIR), "CHIRPS": str(CHIRPS_SOURCE_DIR)},
        "source_file_replacements": {"CHIRPS": chirps_file_replacements},
        "deduplicated_source_files": {"CHIRPS": chirps_file_deduplications},
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "band_years": 15,
        "bands": BANDS,
        "variables": output_variables,
        "aggregation_by_variable": aggregation_by_variable,
        "coverage_by_band": era5_coverage_by_band,
        "coverage_by_variable": coverage_by_variable,
        "row_count": int(final_df.shape[0]),
        "point_count": int(final_df[["lat", "lon"]].drop_duplicates().shape[0]) if not final_df.empty else 0,
        "columns": list(final_df.columns),
    }
    OUTPUT_META.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print("\nDone.", flush=True)
    print(f"Data: {OUTPUT_PARQUET}", flush=True)
    print(f"Metadata: {OUTPUT_META}", flush=True)
    print(f"Rows: {final_df.shape[0]:,}; elapsed={time.time()-run_start:.1f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reuse-era5",
        action="store_true",
        help="Reuse ERA5-Land rows from the existing output and rebuild only CHIRPS.",
    )
    main(reuse_era5=parser.parse_args().reuse_era5)
