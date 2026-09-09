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
