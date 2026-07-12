"""
Precompute long-term ERA5 spatial means by fixed year bands.

Outputs:
- long_term_hotspot_band_means.parquet (long-format spatial means)
- long_term_hotspot_metadata.json (bands + variable metadata)

Run:
    python compute_era5_band_means.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


ROOT_DIR = Path(__file__).resolve().parents[3]
SOURCE_DIR = ROOT_DIR / "Database" / "Full_Shape_ERA5"
OUTPUT_DIR = ROOT_DIR / "Outcomes" / "Long_term_hotspot" / "Outputs"
OUTPUT_PARQUET = OUTPUT_DIR / "long_term_hotspot_band_means.parquet"
OUTPUT_META = OUTPUT_DIR / "long_term_hotspot_metadata.json"

EXCLUDE_COLUMNS = {"system:index", ".geo"}
DATE_CANDIDATES = ["date", "Date", "DATE"]
LAT_CANDIDATES = ["latitude", "lat", "Latitude", "Lat"]
LON_CANDIDATES = ["longitude", "lon", "Longitude", "Lon"]
ELEV_CANDIDATES = ["elevation_m", "elev", "elevation", "Elevation_m"]
YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")

BANDS = [
    {"id": "1951_1975", "label": "1951-1975", "start_year": 1951, "end_year": 1975},
    {"id": "1976_2000", "label": "1976-2000", "start_year": 1976, "end_year": 2000},
    {"id": "2001_2025", "label": "2001-2025", "start_year": 2001, "end_year": 2025},
]


def pick_column(columns: List[str], candidates: List[str], field_name: str) -> str:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    raise RuntimeError(f"Could not detect {field_name} column in schema. Columns: {columns}")


def parse_datetime_series(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="raise")
    try:
        return pd.to_datetime(series, errors="raise", format="mixed")
    except TypeError:
        return pd.to_datetime(series, errors="raise")


def extract_years_from_filename(file_path: Path) -> List[int]:
    years = {int(match) for match in YEAR_PATTERN.findall(file_path.stem)}
    return sorted(years)


def select_files_for_band(files: List[Path], start_year: int, end_year: int) -> List[Path]:
    selected: List[Path] = []
    for file_path in files:
        years = extract_years_from_filename(file_path)
        if not years:
            selected.append(file_path)
            continue
        if max(years) < start_year or min(years) > end_year:
            continue
        selected.append(file_path)
    return selected


def detect_schema(file_path: Path) -> Tuple[str, str, str, str, List[str]]:
    columns = list(pq.ParquetFile(file_path).schema.names)
    date_col = pick_column(columns, DATE_CANDIDATES, "date")
    lat_col = pick_column(columns, LAT_CANDIDATES, "latitude")
    lon_col = pick_column(columns, LON_CANDIDATES, "longitude")
    elev_col = pick_column(columns, ELEV_CANDIDATES, "elevation")

    base_cols = {date_col, lat_col, lon_col, elev_col}
    variables = sorted([c for c in columns if c not in EXCLUDE_COLUMNS and c not in base_cols])
    if not variables:
        raise RuntimeError("No variables found after excluding coordinate/date columns.")

    return date_col, lat_col, lon_col, elev_col, variables


def aggregate_band(
    files: List[Path],
    band: Dict[str, object],
    date_col: str,
    lat_col: str,
    lon_col: str,
    elev_col: str,
    variables: List[str],
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
            print(f"[{band['label']}] {idx}/{len(files)} {file_path.name}: 0 rows (filter)")
            continue

        df = table.to_pandas()
        if df.empty:
            print(f"[{band['label']}] {idx}/{len(files)} {file_path.name}: 0 rows")
            continue

        parsed_dates = parse_datetime_series(df[date_col])
        year_mask = (parsed_dates.dt.year >= start_year) & (parsed_dates.dt.year <= end_year)
        if not year_mask.any():
            print(f"[{band['label']}] {idx}/{len(files)} {file_path.name}: 0 rows (year mask)")
            continue

        scoped = df.loc[year_mask, [lat_col, lon_col, elev_col] + variables].copy()
        for col in [lat_col, lon_col, elev_col] + variables:
            scoped[col] = pd.to_numeric(scoped[col], errors="coerce")

        scoped = scoped.dropna(subset=[lat_col, lon_col])
        if scoped.empty:
            print(f"[{band['label']}] {idx}/{len(files)} {file_path.name}: 0 rows (no valid coords)")
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
        if accumulator is None:
            accumulator = grouped
        else:
            accumulator = accumulator.add(grouped, fill_value=0)

        processed_rows += int(scoped.shape[0])
        print(
            f"[{band['label']}] {idx}/{len(files)} {file_path.name}: "
            f"rows={scoped.shape[0]:,}, points={grouped.shape[0]:,}, elapsed={time.time()-t0:.1f}s"
        )

    if accumulator is None or accumulator.empty:
        return pd.DataFrame(
            columns=[
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
            ]
        )

    accumulator = accumulator.fillna(0).reset_index()

    long_frames: List[pd.DataFrame] = []
    elev_count = pd.to_numeric(accumulator["elev_count"], errors="coerce")
    elev_mean = pd.to_numeric(accumulator["elev_sum"], errors="coerce") / elev_count.replace({0: np.nan})

    for variable in variables:
        var_sum = pd.to_numeric(accumulator[f"{variable}_sum"], errors="coerce")
        var_count = pd.to_numeric(accumulator[f"{variable}_count"], errors="coerce")
        mean_value = var_sum / var_count.replace({0: np.nan})

        frame = pd.DataFrame(
            {
                "band_id": str(band["id"]),
                "band_label": str(band["label"]),
                "start_year": start_year,
                "end_year": end_year,
                "variable": variable,
                "lat": pd.to_numeric(accumulator[lat_col], errors="coerce"),
                "lon": pd.to_numeric(accumulator[lon_col], errors="coerce"),
                "elev": elev_mean,
                "value": mean_value,
                "sample_count": var_count.astype("Int64"),
            }
        )
        frame = frame.dropna(subset=["lat", "lon", "value"])
        long_frames.append(frame)

    result = pd.concat(long_frames, ignore_index=True)
    result["sample_count"] = result["sample_count"].fillna(0).astype(int)

    print(
        f"[{band['label']}] Completed: points={result[['lat', 'lon']].drop_duplicates().shape[0]:,}, "
        f"rows={result.shape[0]:,}, processed_rows={processed_rows:,}, elapsed={time.time()-t0:.1f}s"
    )
    return result


def main() -> None:
    if not SOURCE_DIR.exists():
        raise SystemExit(f"ERA5 source folder not found: {SOURCE_DIR}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    parquet_files = sorted(SOURCE_DIR.glob("*.parquet"))
    if not parquet_files:
        raise SystemExit(f"No parquet files found in source folder: {SOURCE_DIR}")

    date_col, lat_col, lon_col, elev_col, variables = detect_schema(parquet_files[0])
    print(f"Source: {SOURCE_DIR}")
    print(f"Total parquet files: {len(parquet_files)}")
    print(f"Detected variables ({len(variables)}): {variables}")

    output_frames: List[pd.DataFrame] = []
    run_start = time.time()
    for band in BANDS:
        selected_files = select_files_for_band(
            parquet_files,
            int(band["start_year"]),
            int(band["end_year"]),
        )
        print(
            f"\nProcessing band {band['label']} ({band['start_year']} to {band['end_year']}), "
            f"files: {len(selected_files)}"
        )
        band_df = aggregate_band(
            selected_files,
            band,
            date_col=date_col,
            lat_col=lat_col,
            lon_col=lon_col,
            elev_col=elev_col,
            variables=variables,
        )
        output_frames.append(band_df)

    final_df = pd.concat(output_frames, ignore_index=True)
    final_df = final_df.sort_values(["variable", "band_id", "lat", "lon"], ignore_index=True)
    final_df.to_parquet(OUTPUT_PARQUET, index=False)

    metadata = {
        "outcome_id": "long_term_hotspot",
        "outcome_label": "Long Term Hotspot Analysis",
        "dataset": "era5",
        "source_path": str(SOURCE_DIR),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bands": BANDS,
        "variables": variables,
        "row_count": int(final_df.shape[0]),
        "point_count": int(final_df[["lat", "lon"]].drop_duplicates().shape[0]) if not final_df.empty else 0,
        "columns": list(final_df.columns),
    }
    OUTPUT_META.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    elapsed = time.time() - run_start
    print("\nDone.")
    print(f"Output parquet: {OUTPUT_PARQUET}")
    print(f"Output metadata: {OUTPUT_META}")
    print(f"Rows: {final_df.shape[0]:,}")
    print(f"Elapsed: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
