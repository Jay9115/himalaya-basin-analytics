"""Compute later-minus-earlier maps for the saved 15-year outcome bands."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd


ROOT_DIR = Path(__file__).resolve().parents[3]
OUTPUT_DIR = ROOT_DIR / "Outcomes" / "Long_term_hotspot_15yr" / "Outputs"
BAND_VALUES_PARQUET = OUTPUT_DIR / "long_term_hotspot_15yr_band_values.parquet"
BAND_VALUES_META = OUTPUT_DIR / "long_term_hotspot_15yr_metadata.json"
DIFFERENCE_PARQUET = OUTPUT_DIR / "long_term_hotspot_15yr_band_differences.parquet"
DIFFERENCE_META = OUTPUT_DIR / "long_term_hotspot_15yr_band_differences_metadata.json"


def build_comparisons(bands: List[Dict]) -> List[Dict]:
    ordered = sorted(bands, key=lambda band: (int(band["start_year"]), int(band["end_year"])))
    comparisons: List[Dict] = []
    pairs = list(zip(ordered, ordered[1:]))
    if len(ordered) > 2:
        pairs.append((ordered[0], ordered[-1]))
    for earlier, later in pairs:
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
    return comparisons


def compute_difference(df: pd.DataFrame, comparison: Dict) -> pd.DataFrame:
    keys = ["variable", "source_dataset", "aggregation", "lat", "lon"]
    earlier = df[df["band_id"].astype(str) == comparison["earlier_band_id"]].rename(
        columns={"value": "earlier_value", "sample_count": "earlier_sample_count", "elev": "earlier_elev"}
    )
    later = df[df["band_id"].astype(str) == comparison["later_band_id"]].rename(
        columns={"value": "later_value", "sample_count": "later_sample_count", "elev": "later_elev"}
    )
    merged = later[keys + ["later_value", "later_sample_count", "later_elev"]].merge(
        earlier[keys + ["earlier_value", "earlier_sample_count", "earlier_elev"]],
        on=keys,
        how="inner",
    )
    if merged.empty:
        return merged
    merged["change_value"] = merged["later_value"] - merged["earlier_value"]
    merged["abs_change_value"] = merged["change_value"].abs()
    merged["pct_change_value"] = np.where(
        merged["earlier_value"].abs() > 1e-12,
        merged["change_value"] / merged["earlier_value"] * 100.0,
        np.nan,
    )
    merged["elev"] = merged[["later_elev", "earlier_elev"]].mean(axis=1, skipna=True)
    for key, value in comparison.items():
        merged[key] = value
    return merged[
        [
            "id", "label", "earlier_band_id", "earlier_band_label", "later_band_id",
            "later_band_label", "earlier_start_year", "earlier_end_year", "later_start_year",
            "later_end_year", "variable", "source_dataset", "aggregation", "lat", "lon", "elev",
            "earlier_value", "later_value", "change_value", "abs_change_value",
            "pct_change_value", "earlier_sample_count", "later_sample_count",
        ]
    ]


def main() -> None:
    if not BAND_VALUES_PARQUET.exists():
        raise SystemExit(f"15-year band data not found: {BAND_VALUES_PARQUET}")
    source_meta = json.loads(BAND_VALUES_META.read_text(encoding="utf-8"))
    df = pd.read_parquet(BAND_VALUES_PARQUET)
    comparisons = build_comparisons(source_meta["bands"])
    frames = []
    for comparison in comparisons:
        print(f"Computing {comparison['label']}", flush=True)
        frames.append(compute_difference(df, comparison))
    final_df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if not final_df.empty:
        final_df = final_df.sort_values(["variable", "id", "lat", "lon"], ignore_index=True)
    final_df.to_parquet(DIFFERENCE_PARQUET, index=False)
    metadata = {
        "outcome_id": "long_term_hotspot_15yr",
        "output_type": "band_difference",
        "dataset": source_meta.get("dataset", "era5_chirps"),
        "source_band_values_path": str(BAND_VALUES_PARQUET),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "difference_definition": "change_value = later_band_value - earlier_band_value",
        "bands": source_meta["bands"],
        "comparisons": comparisons,
        "variables": source_meta["variables"],
        "aggregation_by_variable": source_meta["aggregation_by_variable"],
        "coverage_by_band": source_meta.get("coverage_by_band", []),
        "coverage_by_variable": source_meta.get("coverage_by_variable", {}),
        "row_count": int(final_df.shape[0]),
        "point_count": int(final_df[["lat", "lon"]].drop_duplicates().shape[0]) if not final_df.empty else 0,
        "columns": list(final_df.columns),
    }
    DIFFERENCE_META.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Saved {final_df.shape[0]:,} rows to {DIFFERENCE_PARQUET}", flush=True)


if __name__ == "__main__":
    main()
