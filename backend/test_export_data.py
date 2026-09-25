"""
Tests for the Export Data module:
- Schema validation
- Helper utilities (date parsing, month/year keys)
- Job registry lifecycle and cancellation
- ZIP packaging
"""

import os
import shutil
import tempfile
from pathlib import Path
import pytest
from pydantic import ValidationError

from export_data.schemas import ExportRequest, ExportProgress
from export_data.worker import (
    _parse_date,
    _format_date_indian,
    _safe_filename,
    _month_key,
    _year_key,
    _register_job,
    get_job,
    get_job_progress,
    cancel_job,
    get_job_files,
    get_job_output_dir,
    _package_zip,
)


def test_export_request_validation():
    # Valid minimal payload
    req = ExportRequest(
        variables=["temperature_c", "precipitation_mm"],
        start_date="2023-01-01",
        end_date="2023-12-31",
        export_temporal_csv=True,
    )
    assert req.variables == ["temperature_c", "precipitation_mm"]
    assert req.start_date == "2023-01-01"
    assert req.export_temporal_csv is True
    assert req.spatial_format == "geotiff"
    assert req.destination_folder is None


def test_export_request_with_destination_folder():
    req = ExportRequest(
        variables=["temperature_c"],
        start_date="01-01-2023",
        end_date="31-12-2023",
        export_spatial_maps=True,
        spatial_format="csv",
        spatial_aggregation="monthly",
        destination_folder="D:/MyExports/Basin",
    )
    assert req.destination_folder == "D:/MyExports/Basin"
    assert req.spatial_aggregation == "monthly"


def test_export_request_requires_variables():
    with pytest.raises(ValidationError):
        ExportRequest(
            variables=[],
            start_date="2023-01-01",
            end_date="2023-12-31",
        )


def test_date_helpers():
    assert _parse_date("2023-05-15") == "2023-05-15"
    assert _parse_date("15-05-2023") == "2023-05-15"
    assert _parse_date("15/05/2023") == "2023-05-15"
    assert _format_date_indian("2023-05-15") == "15-05-2023"
    assert _month_key("2023-05-15") == "2023-05"
    assert _year_key("2023-05-15") == "2023"
    assert _safe_filename("temp (c) / day") == "temp__c____day"


def test_job_registry_and_cancellation():
    req = ExportRequest(
        variables=["temperature_c"],
        start_date="2023-01-01",
        end_date="2023-01-31",
        export_temporal_csv=True,
    )
    job_id = "exp_test12345678"
    entry = _register_job(job_id, req)
    assert entry["id"] == job_id
    assert entry["status"] == "queued"

    progress = get_job_progress(job_id)
    assert progress is not None
    assert progress.job_id == job_id
    assert progress.status == "queued"

    # Test cancel
    assert cancel_job(job_id) is True
    assert get_job_progress(job_id).status == "cancelled"


def test_zip_packaging():
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        # Create dummy exported files
        sub = tmp_dir / "out" / "temporal"
        sub.mkdir(parents=True)
        sample_file = sub / "temp.csv"
        sample_file.write_text("date,mean_value\n2023-01-01,10.5\n", encoding="utf-8")

        zip_path_str = _package_zip(tmp_dir / "out", tmp_dir)
        zip_path = Path(zip_path_str)
        assert zip_path.exists()
        assert zip_path.stat().st_size > 0
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_export_request_with_alternate_dataset():
    # User selects a different dataset from the dropdown (e.g., sphy_model, mod10a1, cmip6)
    req = ExportRequest(
        dataset="sphy_model",
        variables=["GMel", "SMel"],
        start_date="2005-01-01",
        end_date="2005-12-31",
        export_temporal_csv=True,
    )
    assert req.dataset == "sphy_model"
    assert req.variables == ["GMel", "SMel"]


def test_export_request_with_custom_variable():
    # User enters an unlisted or custom variable name
    req = ExportRequest(
        dataset="era5",
        variables=["temperature_c", "custom_derived_var"],
        start_date="2023-01-01",
        end_date="2023-01-10",
        export_temporal_csv=True,
    )
    assert "custom_derived_var" in req.variables


def test_export_request_cross_dataset_variables():
    # User selects variables across multiple datasets
    req = ExportRequest(
        dataset_variables={
            "mod10a1": ["NDSI_Snow_Cover"],
            "era5": ["temperature_2m", "total_precipitation"],
        },
        start_date="2020-01-01",
        end_date="2020-01-31",
        export_temporal_csv=True,
    )
    resolved = req.resolve_dataset_variables()
    assert "mod10a1" in resolved
    assert resolved["mod10a1"] == ["NDSI_Snow_Cover"]
    assert "era5" in resolved
    assert resolved["era5"] == ["temperature_2m", "total_precipitation"]


def test_export_request_composite_prefixed_variables():
    # Variables specified as dataset_id:var_name
    req = ExportRequest(
        variables=["mod10a1:NDSI_Snow_Cover", "sphy_model:GMel", "precipitation"],
        dataset="era5",
        start_date="2020-01-01",
        end_date="2020-01-31",
        export_temporal_csv=True,
    )
    resolved = req.resolve_dataset_variables()
    assert resolved["mod10a1"] == ["NDSI_Snow_Cover"]
    assert resolved["sphy_model"] == ["GMel"]
    assert resolved["era5"] == ["precipitation"]


def test_temporal_csv_redundancy_reduction_and_header():
    from unittest.mock import MagicMock, patch
    from custom_operations.data_access import OperationBackendHooks
    from export_data.worker import _export_temporal_csv

    tmp_dir = Path(tempfile.mkdtemp())
    try:
        req = ExportRequest(
            dataset_variables={
                "mod10a1": ["NDSI_Snow_Cover"],
                "era5": ["temperature_2m"],
            },
            start_date="2020-01-01",
            end_date="2020-01-03",
            export_temporal_csv=True,
        )
        resolved = req.resolve_dataset_variables()
        job = _register_job("exp_test_redux", req)

        hooks = MagicMock()
        hooks.normalize_year_range.return_value = (None, None)
        hooks.ensure_dataset_loaded.side_effect = lambda ds, **_: {
            "id": ds,
            "label": f"Dataset {ds}",
            "variables": ["NDSI_Snow_Cover", "temperature_2m"],
            "all_columns": [],
        }
        hooks.resolve_elevation_bounds.return_value = (500.0, 9000.0)
        hooks.get_subregion.return_value = None

        mock_data = [
            {"date": "2020-01-01", "mean_value": 15.5, "pixel_count": 48201},
            {"date": "2020-01-02", "mean_value": 16.0, "pixel_count": 48201},
            {"date": "2020-01-03", "mean_value": 14.8, "pixel_count": 48201},
        ]

        with patch("main.calculate_basin_mean", return_value=mock_data), \
             patch("main.snapshot_dataset_state", side_effect=lambda s: s):
            files = _export_temporal_csv(
                hooks=hooks,
                request=req,
                resolved_ds_vars=resolved,
                output_dir=tmp_dir,
                job=job,
                progress_offset=0,
                progress_total=30,
            )

        assert len(files) == 3  # mod10a1 csv, era5 csv, and combined timeseries csv

        # Verify individual CSV content
        mod10a1_csv = [Path(f) for f in files if "mod10a1" in Path(f).name][0]
        content = mod10a1_csv.read_text(encoding="utf-8")

        # 1. No redundant date_display
        assert "date_display" not in content
        # 2. Pixel count is noted in header comment, not repeated on every row
        assert "# Pixel Count: 48201 (constant across all timesteps)" in content
        lines = [line for line in content.splitlines() if not line.startswith("#")]
        header_line = lines[0]
        assert header_line == "date,mean_value"
        assert lines[1] == "2020-01-01,15.5"

        # Verify combined CSV
        combined_csv = [Path(f) for f in files if "combined" in Path(f).name][0]
        c_content = combined_csv.read_text(encoding="utf-8")
        c_lines = [line for line in c_content.splitlines() if not line.startswith("#")]
        assert "date,mod10a1__NDSI_Snow_Cover,era5__temperature_2m" == c_lines[0]
        assert "2020-01-01,15.5,15.5" == c_lines[1]
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_is_sum_variable():
    from main import is_sum_variable
    assert is_sum_variable("precipitation_mm") is True
    assert is_sum_variable("precip_mm_day") is True
    assert is_sum_variable("snowfall_mm") is True
    assert is_sum_variable("cold_snowfall_mm") is True
    assert is_sum_variable("RAINFALL") is True
    assert is_sum_variable("pr") is True
    assert is_sum_variable("tp") is True
    assert is_sum_variable("sf") is True
    # Non-sum variables
    assert is_sum_variable("temperature_C") is False
    assert is_sum_variable("wind_speed_ms") is False
    assert is_sum_variable("SWE_mm") is False
    assert is_sum_variable("snow_depth_mm") is False
    assert is_sum_variable("snowfall_fraction") is False
    assert is_sum_variable("snowfall_days_ge1") is False


def test_temporal_csv_sum_variable_export():
    import tempfile, shutil, threading
    from unittest.mock import MagicMock, patch
    from main import is_sum_variable
    from export_data.worker import _export_temporal_csv

    tmp_dir = Path(tempfile.mkdtemp())
    try:
        req = ExportRequest(
            dataset="chirps",
            variables=["precipitation_mm"],
            start_date="2020-01-01",
            end_date="2020-01-03",
        )
        resolved = {"chirps": ["precipitation_mm"]}
        job = {"id": "test_sum", "status": "running", "cancel_event": threading.Event()}

        hooks = MagicMock()
        hooks.normalize_year_range.return_value = (None, None)
        hooks.ensure_dataset_loaded.return_value = {
            "id": "chirps",
            "label": "CHIRPS Precipitation",
            "variables": ["precipitation_mm"],
            "all_columns": [],
        }
        hooks.resolve_elevation_bounds.return_value = (0.0, 9000.0)
        hooks.get_subregion.return_value = None

        mock_data = [
            {"date": "2020-01-01", "mean_value": 450.5, "value": 450.5, "pixel_count": 32000},
            {"date": "2020-01-02", "mean_value": 520.0, "value": 520.0, "pixel_count": 32000},
            {"date": "2020-01-03", "mean_value": 310.2, "value": 310.2, "pixel_count": 32000},
        ]

        with patch("main.calculate_basin_mean", return_value=mock_data), \
             patch("main.snapshot_dataset_state", side_effect=lambda s: s):
            files = _export_temporal_csv(
                hooks=hooks,
                request=req,
                resolved_ds_vars=resolved,
                output_dir=tmp_dir,
                job=job,
                progress_offset=0,
                progress_total=30,
            )

        assert len(files) == 1
        csv_file = Path(files[0])
        content = csv_file.read_text(encoding="utf-8")

        assert "# Export: Temporal Basin Sum Time Series" in content
        assert "# Aggregation: Sum across ROI" in content
        assert "# Pixel Count: 32000 (constant across all timesteps)" in content

        lines = [l for l in content.splitlines() if not l.startswith("#")]
        assert lines[0] == "date,sum_value"
        assert lines[1] == "2020-01-01,450.5"
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_calculate_basin_mean_aggregation_formula():
    import pandas as pd
    from unittest.mock import patch
    import main

    # Create dummy dataframe with 2 pixels on 2020-01-01
    # pixel 1: 10.0, pixel 2: 20.0
    mock_df = pd.DataFrame({
        "date": [pd.Timestamp("2020-01-01"), pd.Timestamp("2020-01-01")],
        "lat": [35.0, 35.1],
        "lon": [75.0, 75.1],
        "elev": [1000.0, 1000.0],
        "precipitation_mm": [10.0, 20.0],
        "snowfall_mm": [5.0, 15.0],
        "temperature_C": [10.0, 20.0],
    })

    dummy_state = {
        "id": "dummy",
        "label": "Dummy",
        "date_index": {"2020-01-01": ["dummy.parquet"]},
        "date_col": "date",
        "lat_col": "lat",
        "lon_col": "lon",
        "elev_col": "elev",
        "storage": "parquet",
        "variables": ["precipitation_mm", "snowfall_mm", "temperature_C"],
    }

    with patch("main.is_geotiff_dataset", return_value=False), \
         patch("main.is_geoparquet_dataset", return_value=False), \
         patch("main.read_parquet_subset", return_value=mock_df):

        # Precipitation should SUM: 10.0 + 20.0 = 30.0
        res_precip = main.calculate_basin_mean(
            dummy_state, "2020-01-01", "2020-01-01", 0, 9000, "precipitation_mm"
        )
        assert len(res_precip) == 1
        assert res_precip[0]["value"] == 30.0
        assert res_precip[0]["mean_value"] == 30.0
        assert res_precip[0]["pixel_count"] == 2

        # Snowfall should SUM: 5.0 + 15.0 = 20.0
        res_snow = main.calculate_basin_mean(
            dummy_state, "2020-01-01", "2020-01-01", 0, 9000, "snowfall_mm"
        )
        assert len(res_snow) == 1
        assert res_snow[0]["value"] == 20.0
        assert res_snow[0]["mean_value"] == 20.0

        # Temperature should MEAN: (10.0 + 20.0) / 2 = 15.0
        res_temp = main.calculate_basin_mean(
            dummy_state, "2020-01-01", "2020-01-01", 0, 9000, "temperature_C"
        )
        assert len(res_temp) == 1
        assert res_temp[0]["value"] == 15.0
        assert res_temp[0]["mean_value"] == 15.0
