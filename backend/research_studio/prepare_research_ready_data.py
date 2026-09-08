"""Build compact annual research tables from the verified local analysis caches.

This is a one-way preparation step: source arrays and source datasets are opened
read-only and the derived Parquet tables are written to Database/Research_Ready.
The runtime Research Studio never needs to scan the multi-billion-row daily
archive for routine annual trend, anomaly, emergence, or change-point work.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict

import numpy as np
import pandas as pd


APP_ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_ROOT = APP_ROOT.parents[1]
DEFAULT_OUTPUT = APP_ROOT / "Database" / "Research_Ready"
STUDY_ROOT = WORKSPACE_ROOT / "RESERACH_EX"
DRIVER_ROOT = STUDY_ROOT / "RESEARCH_02_ENVIRONMENTAL_DRIVERS"


ERA_VARIABLES: Dict[str, Dict[str, str]] = {
    "temperature_C": {"label": "Annual mean temperature", "unit": "°C", "source": "ERA5-Land"},
    "freeze_days": {"label": "Freeze days", "unit": "days", "source": "ERA5-Land"},
    "transition_days": {"label": "Rain–snow transition days", "unit": "days", "source": "ERA5-Land"},
    "thaw_degree_days": {"label": "Thaw degree days", "unit": "°C day", "source": "ERA5-Land"},
    "freezing_degree_days": {"label": "Freezing degree days", "unit": "°C day", "source": "ERA5-Land"},
    "warmest_7day_mean": {"label": "Warmest 7-day mean", "unit": "°C", "source": "ERA5-Land"},
    "coldest_7day_mean": {"label": "Coldest 7-day mean", "unit": "°C", "source": "ERA5-Land"},
    "DJF_temperature_C": {"label": "DJF mean temperature", "unit": "°C", "source": "ERA5-Land"},
    "MAM_temperature_C": {"label": "MAM mean temperature", "unit": "°C", "source": "ERA5-Land"},
    "JJAS_temperature_C": {"label": "JJAS mean temperature", "unit": "°C", "source": "ERA5-Land"},
    "ON_temperature_C": {"label": "ON mean temperature", "unit": "°C", "source": "ERA5-Land"},
    "precipitation_mm": {"label": "Annual precipitation", "unit": "mm yr⁻¹", "source": "ERA5-Land"},
    "snowfall_mm": {"label": "Annual snowfall", "unit": "mm yr⁻¹", "source": "ERA5-Land"},
    "snowfall_fraction": {"label": "Snowfall fraction", "unit": "fraction", "source": "ERA5-Land"},
    "cold_precipitation_mm": {"label": "Cold-season precipitation", "unit": "mm", "source": "ERA5-Land"},
    "cold_snowfall_mm": {"label": "Cold-season snowfall", "unit": "mm", "source": "ERA5-Land"},
    "cold_snowfall_fraction": {"label": "Cold-season snowfall fraction", "unit": "fraction", "source": "ERA5-Land"},
    "snowfall_days_ge1": {"label": "Snowfall days ≥1 mm", "unit": "days", "source": "ERA5-Land"},
    "solar_radiation_MJm2_day": {"label": "Mean surface solar radiation", "unit": "MJ m⁻² day⁻¹", "source": "ERA5-Land"},
    "cold_solar_radiation_MJm2_day": {"label": "Cold-season solar radiation", "unit": "MJ m⁻² day⁻¹", "source": "ERA5-Land"},
    "wind_speed_ms": {"label": "Mean 10 m wind speed", "unit": "m s⁻¹", "source": "ERA5-Land"},
    "MODIS_annual_snow_cover_percent": {"label": "MODIS annual snow cover", "unit": "%", "source": "MOD10A1"},
    "MODIS_cold_snow_cover_percent": {"label": "MODIS cold-season snow cover", "unit": "%", "source": "MOD10A1"},
    "MODIS_DJF_snow_cover_percent": {"label": "MODIS DJF snow cover", "unit": "%", "source": "MOD10A1"},
    "MODIS_MAM_snow_cover_percent": {"label": "MODIS MAM snow cover", "unit": "%", "source": "MOD10A1"},
    "MODIS_annual_snow_albedo_percent": {"label": "MODIS annual snow albedo", "unit": "%", "source": "MOD10A1"},
    "MODIS_months_snow_cover_ge50": {"label": "Months with snow cover ≥50%", "unit": "months", "source": "MOD10A1"},
}

CHIRPS_VARIABLES: Dict[str, Dict[str, str]] = {
    "precipitation_mm": {"label": "Annual precipitation", "unit": "mm yr⁻¹", "source": "CHIRPS"},
    "rx1day": {"label": "Annual maximum 1-day precipitation", "unit": "mm", "source": "CHIRPS"},
    "rx5day": {"label": "Annual maximum consecutive 5-day precipitation", "unit": "mm", "source": "CHIRPS"},
    "wet_days": {"label": "Wet days", "unit": "days", "source": "CHIRPS"},
    "heavy20_days": {"label": "Days with precipitation ≥20 mm", "unit": "days", "source": "CHIRPS"},
    "sdii": {"label": "Simple daily intensity index", "unit": "mm wet-day⁻¹", "source": "CHIRPS"},
    "cdd": {"label": "Maximum consecutive dry days", "unit": "days", "source": "CHIRPS"},
    "top5_fraction": {"label": "Top-five-day precipitation fraction", "unit": "fraction", "source": "CHIRPS"},
    "r95ptot": {"label": "Very-wet-day precipitation", "unit": "mm", "source": "CHIRPS"},
    "r99ptot": {"label": "Extremely-wet-day precipitation", "unit": "mm", "source": "CHIRPS"},
    "pci": {"label": "Precipitation concentration index", "unit": "index", "source": "CHIRPS"},
    "seasonality_entropy": {"label": "Precipitation seasonality entropy", "unit": "index", "source": "CHIRPS"},
    "DJF_precipitation_mm": {"label": "DJF precipitation", "unit": "mm", "source": "CHIRPS"},
    "MAM_precipitation_mm": {"label": "MAM precipitation", "unit": "mm", "source": "CHIRPS"},
    "JJAS_precipitation_mm": {"label": "JJAS precipitation", "unit": "mm", "source": "CHIRPS"},
    "ON_precipitation_mm": {"label": "ON precipitation", "unit": "mm", "source": "CHIRPS"},
}


def _expanded_metadata(meta: pd.DataFrame, years: np.ndarray) -> pd.DataFrame:
    n_pixels = len(meta)
    output = pd.DataFrame(
        {
            "year": np.repeat(years.astype(np.int16), n_pixels),
            "pixel_id": np.tile(meta["pixel_id"].to_numpy(np.int32), len(years)),
            "latitude": np.tile(meta["latitude"].to_numpy(np.float32), len(years)),
            "longitude": np.tile(meta["longitude"].to_numpy(np.float32), len(years)),
            "elevation_m": np.tile(meta["elevation_m"].to_numpy(np.float32), len(years)),
            "basin": np.tile(meta["basin"].fillna(-1).to_numpy(np.int16), len(years)),
            "sector": np.tile(meta["sector"].astype("category").astype(str).to_numpy(), len(years)),
            "elevation_band": np.tile(meta["elevation_band"].astype("category").astype(str).to_numpy(), len(years)),
            "coslat_weight": np.tile(np.cos(np.deg2rad(meta["latitude"].to_numpy(float))).astype(np.float32), len(years)),
        }
    )
    return output


def build_era(output_dir: Path) -> dict:
    temperature_cache = np.load(STUDY_ROOT / "cache" / "era5_temperature_pixel_year_metrics.npz")
    driver_cache = np.load(DRIVER_ROOT / "cache" / "era5_driver_pixel_year_metrics.npz")
    modis_cache = np.load(DRIVER_ROOT / "cache" / "modis_snow_pixel_year_metrics.npz")
    meta = pd.read_parquet(DRIVER_ROOT / "tables" / "environmental_driver_spatial_frame.parquet")[
        ["pixel_id", "latitude", "longitude", "elevation_m", "basin", "sector", "elevation_band"]
    ]

    years = temperature_cache["years"].astype(int)
    if not np.array_equal(years, driver_cache["years"].astype(int)):
        raise ValueError("ERA5 temperature and environmental-driver caches have different year axes.")
    frame = _expanded_metadata(meta, years)

    temperature_mapping = {
        "temperature_C": "annual_mean",
        "freeze_days": "freeze_days",
        "transition_days": "transition_days",
        "thaw_degree_days": "thaw_degree_days",
        "freezing_degree_days": "freezing_degree_days",
        "warmest_7day_mean": "warmest_7day_mean",
        "coldest_7day_mean": "coldest_7day_mean",
        "DJF_temperature_C": "DJF_mean",
        "MAM_temperature_C": "MAM_mean",
        "JJAS_temperature_C": "JJAS_mean",
        "ON_temperature_C": "ON_mean",
    }
    driver_mapping = {
        "precipitation_mm": "era_precip_total",
        "snowfall_mm": "snowfall_total",
        "snowfall_fraction": "snowfall_fraction",
        "cold_precipitation_mm": "cold_precip_total",
        "cold_snowfall_mm": "cold_snowfall_total",
        "cold_snowfall_fraction": "cold_snowfall_fraction",
        "snowfall_days_ge1": "snowfall_days_ge1",
        "solar_radiation_MJm2_day": "solar_mean",
        "cold_solar_radiation_MJm2_day": "cold_solar_mean",
        "wind_speed_ms": "wind_mean",
    }
    for output_name, cache_name in temperature_mapping.items():
        frame[output_name] = temperature_cache[cache_name].astype(np.float32).reshape(-1)
    for output_name, cache_name in driver_mapping.items():
        frame[output_name] = driver_cache[cache_name].astype(np.float32).reshape(-1)

    modis_mapping = {
        "MODIS_annual_snow_cover_percent": "annual_snow_cover",
        "MODIS_cold_snow_cover_percent": "cold_snow_cover",
        "MODIS_DJF_snow_cover_percent": "DJF_snow_cover",
        "MODIS_MAM_snow_cover_percent": "MAM_snow_cover",
        "MODIS_annual_snow_albedo_percent": "annual_snow_albedo",
        "MODIS_months_snow_cover_ge50": "months_snow_cover_ge50",
    }
    modis_years = modis_cache["years"].astype(int)
    modis_lookup = {int(year): index for index, year in enumerate(modis_years)}
    for output_name, cache_name in modis_mapping.items():
        aligned = np.full((len(years), len(meta)), np.nan, dtype=np.float32)
        values = modis_cache[cache_name].astype(np.float32)
        for era_index, year in enumerate(years):
            if int(year) in modis_lookup:
                aligned[era_index] = values[modis_lookup[int(year)]]
        frame[output_name] = aligned.reshape(-1)

    path = output_dir / "era5_annual_research.parquet"
    frame.to_parquet(path, index=False, compression="zstd")
    return {
        "id": "era5_annual",
        "label": "ERA5-Land annual research cube",
        "path": path.name,
        "years": [int(years.min()), int(years.max())],
        "available_years": years.tolist(),
        "pixels": int(len(meta)),
        "rows": int(len(frame)),
        "variables": ERA_VARIABLES,
        "caveats": [
            "The local ERA5-Land annual archive does not contain 2001.",
            "ERA5-Land is a reanalysis and does not replace high-elevation station validation.",
            "MODIS variables are available only for 2001–2025 and retain the local monthly-export provenance limitation.",
        ],
    }


def build_chirps(output_dir: Path) -> dict:
    cache = np.load(STUDY_ROOT / "cache" / "chirps_precipitation_pixel_year_metrics.npz")
    meta = pd.read_parquet(STUDY_ROOT / "tables" / "chirps_spatial_trends.parquet")[
        ["pixel_id", "latitude", "longitude", "elevation_m", "basin", "sector", "elevation_band"]
    ]
    years = cache["years"].astype(int)
    frame = _expanded_metadata(meta, years)
    mapping = {
        "precipitation_mm": "annual_total",
        "rx1day": "rx1day",
        "rx5day": "rx5day",
        "wet_days": "wet_days",
        "heavy20_days": "heavy20_days",
        "sdii": "sdii",
        "cdd": "cdd",
        "top5_fraction": "top5_fraction",
        "r95ptot": "r95ptot",
        "r99ptot": "r99ptot",
        "pci": "pci",
        "seasonality_entropy": "seasonality_entropy",
        "DJF_precipitation_mm": "DJF_total",
        "MAM_precipitation_mm": "MAM_total",
        "JJAS_precipitation_mm": "JJAS_total",
        "ON_precipitation_mm": "ON_total",
    }
    for output_name, cache_name in mapping.items():
        frame[output_name] = cache[cache_name].astype(np.float32).reshape(-1)
    path = output_dir / "chirps_annual_research.parquet"
    frame.to_parquet(path, index=False, compression="zstd")
    return {
        "id": "chirps_annual",
        "label": "CHIRPS annual precipitation research cube",
        "path": path.name,
        "years": [int(years.min()), int(years.max())],
        "available_years": years.tolist(),
        "pixels": int(len(meta)),
        "rows": int(len(frame)),
        "variables": CHIRPS_VARIABLES,
        "caveats": [
            "The local research cache identifies the product as CHIRPS v3; final manuscript provenance should confirm the production release.",
            "Complex terrain and sparse high-elevation gauges can affect precipitation magnitude and extremes.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    datasets = [build_era(output_dir), build_chirps(output_dir)]
    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_data_modified": False,
        "description": "Annual research-ready cubes for guided web analysis; derived from verified local caches.",
        "datasets": datasets,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output_dir), "datasets": [item["id"] for item in datasets]}, indent=2))


if __name__ == "__main__":
    main()

