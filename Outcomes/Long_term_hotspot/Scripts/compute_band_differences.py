"""
Compute saved long-term band difference maps.

Input:
- long_term_hotspot_band_means.parquet

Outputs:
- long_term_hotspot_band_differences.parquet
- long_term_hotspot_band_differences_metadata.json

Difference definition:
    change_value = later_band_mean - earlier_band_mean

Run:
    python compute_band_differences.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd


ROOT_DIR = Path(__file__).resolve().parents[3]
OUTPUT_DIR = ROOT_DIR / "Outcomes" / "Long_term_hotspot" / "Outputs"
BAND_MEANS_PARQUET = OUTPUT_DIR / "long_term_hotspot_band_means.parquet"
BAND_MEANS_META = OUTPUT_DIR / "long_term_hotspot_metadata.json"
DIFFERENCE_PARQUET = OUTPUT_DIR / "long_term_hotspot_band_differences.parquet"
DIFFERENCE_META = OUTPUT_DIR / "long_term_hotspot_band_differences_metadata.json"


def load_band_metadata() -> Dict:
    if BAND_MEANS_META.exists():
        return json.loads(BAND_MEANS_META.read_text(encoding="utf-8"))
    return {}


def build_comparisons(bands: List[Dict]) -> List[Dict]:
    ordered_bands = sorted(
        bands,
        key=lambda band: (int(band["start_year"]), int(band["end_year"]), str(band["id"])),
    )
    comparisons: List[Dict] = []

    for index in range(1, len(ordered_bands)):
        earlier = ordered_bands[index - 1]
        later = ordered_bands[index]
        comparisons.append(
            {
                "id": f"{later['id']}__minus__{earlier['id']}",
                "label": f"{later['label']} minus {earlier['label']}",
                "earlier_band_id": str(earlier["id"]),
                "earlier_band_label": str(earlier["label"]),
                "later_band_id": str(later["id"]),
                "later_band_label": str(later["label"]),
                "earlier_start_year": int(earlier["start_year"]),
                "earlier_end_year": int(earlier["end_year"]),
                "later_start_year": int(later["start_year"]),
                "later_end_year": int(later["end_year"]),
            }
        )

    if len(ordered_bands) >= 2:
        first = ordered_bands[0]
        last = ordered_bands[-1]
        full_id = f"{last['id']}__minus__{first['id']}"
        if all(comparison["id"] != full_id for comparison in comparisons):
            comparisons.append(
                {
                    "id": full_id,
                    "label": f"{last['label']} minus {first['label']}",
                    "earlier_band_id": str(first["id"]),
                    "earlier_band_label": str(first["label"]),
                    "later_band_id": str(last["id"]),
                    "later_band_label": str(last["label"]),
                    "earlier_start_year": int(first["start_year"]),
                    "earlier_end_year": int(first["end_year"]),
                    "later_start_year": int(last["start_year"]),
                    "later_end_year": int(last["end_year"]),
                }
            )

    return comparisons


def compute_difference_for_comparison(df: pd.DataFrame, comparison: Dict) -> pd.DataFrame:
    key_columns = ["variable", "lat", "lon"]
    earlier = df[df["band_id"].astype(str) == comparison["earlier_band_id"]].copy()
    later = df[df["band_id"].astype(str) == comparison["later_band_id"]].copy()

    earlier = earlier.rename(
        columns={
            "value": "earlier_value",
            "sample_count": "earlier_sample_count",
            "elev": "earlier_elev",
        }
    )
    later = later.rename(
        columns={
            "value": "later_value",
            "sample_count": "later_sample_count",
            "elev": "later_elev",
        }
    )

    merged = later[
        key_columns + ["later_value", "later_sample_count", "later_elev"]
    ].merge(
        earlier[key_columns + ["earlier_value", "earlier_sample_count", "earlier_elev"]],
        on=key_columns,
        how="inner",
    )

    if merged.empty:
        return pd.DataFrame()

    merged["change_value"] = merged["later_value"] - merged["earlier_value"]
    merged["abs_change_value"] = merged["change_value"].abs()
    merged["pct_change_value"] = np.where(
        np.isfinite(merged["earlier_value"]) & (merged["earlier_value"].abs() > 1e-12),
        (merged["change_value"] / merged["earlier_value"]) * 100.0,
        np.nan,
    )
    merged["elev"] = merged[["later_elev", "earlier_elev"]].mean(axis=1, skipna=True)

    for key, value in comparison.items():
        merged[key] = value

    return merged[
        [
            "id",
            "label",
            "earlier_band_id",
            "earlier_band_label",
            "later_band_id",
            "later_band_label",
            "earlier_start_year",
            "earlier_end_year",
            "later_start_year",
            "later_end_year",
            "variable",
            "lat",
            "lon",
            "elev",
            "earlier_value",
            "later_value",
            "change_value",
            "abs_change_value",
            "pct_change_value",
            "earlier_sample_count",
            "later_sample_count",
        ]
    ]


def main() -> None:
    if not BAND_MEANS_PARQUET.exists():
        raise SystemExit(f"Band means parquet not found: {BAND_MEANS_PARQUET}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    source_meta = load_band_metadata()
    df = pd.read_parquet(BAND_MEANS_PARQUET)

    required = {"band_id", "band_label", "start_year", "end_year", "variable", "lat", "lon", "elev", "value", "sample_count"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"Missing required columns in band means parquet: {sorted(missing)}")

    bands = source_meta.get("bands")
    if not bands:
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

    comparisons = build_comparisons(bands)
    output_frames = []
    for comparison in comparisons:
        print(f"Computing {comparison['label']}")
        frame = compute_difference_for_comparison(df, comparison)
        print(f"  rows={frame.shape[0]:,}")
        output_frames.append(frame)

    final_df = pd.concat(output_frames, ignore_index=True) if output_frames else pd.DataFrame()
    if not final_df.empty:
        final_df = final_df.sort_values(["variable", "id", "lat", "lon"], ignore_index=True)
    final_df.to_parquet(DIFFERENCE_PARQUET, index=False)

    metadata = {
        "outcome_id": "long_term_hotspot",
        "output_type": "band_difference",
        "dataset": source_meta.get("dataset", "era5"),
        "source_band_means_path": str(BAND_MEANS_PARQUET),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "difference_definition": "change_value = later_band_mean - earlier_band_mean",
        "bands": bands,
        "comparisons": comparisons,
        "variables": source_meta.get("variables", sorted(final_df["variable"].dropna().astype(str).unique().tolist()) if not final_df.empty else []),
        "row_count": int(final_df.shape[0]),
        "point_count": int(final_df[["lat", "lon"]].drop_duplicates().shape[0]) if not final_df.empty else 0,
        "columns": list(final_df.columns),
    }
    DIFFERENCE_META.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print("\nDone.")
    print(f"Difference parquet: {DIFFERENCE_PARQUET}")
    print(f"Difference metadata: {DIFFERENCE_META}")
    print(f"Rows: {final_df.shape[0]:,}")


if __name__ == "__main__":
    main()
