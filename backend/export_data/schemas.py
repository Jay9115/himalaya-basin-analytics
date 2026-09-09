"""Pydantic schemas for the Export Data module."""

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class ExportRequest(BaseModel):
    """Request payload for starting a data export job."""

    model_config = ConfigDict(extra="forbid")

    dataset: Optional[str] = Field(None, description="Dataset id. Defaults to app default dataset.")
    variables: List[str] = Field(..., min_length=1, description="One or more variable names to export.")
    start_date: str = Field(..., description="Temporal filter start date in YYYY-MM-DD or DD-MM-YYYY format.")
    end_date: str = Field(..., description="Temporal filter end date in YYYY-MM-DD or DD-MM-YYYY format.")
    year_start: Optional[int] = Field(None, description="Inclusive index start year.")
    year_end: Optional[int] = Field(None, description="Inclusive index end year.")
    elev_min: Optional[float] = Field(None, description="Minimum elevation filter.")
    elev_max: Optional[float] = Field(None, description="Maximum elevation filter.")
    subregion_id: Optional[str] = Field(None, description="Optional basin/glacier subregion id.")
    aoi_geojson: Optional[str] = Field(None, description="Optional ROI Polygon/MultiPolygon GeoJSON string.")

    # Export type toggles
    export_temporal_csv: bool = Field(False, description="Export temporal basin-mean time series as CSV.")
    export_spatial_maps: bool = Field(False, description="Export spatial raster maps.")

    # Spatial map options (only used when export_spatial_maps is True)
    spatial_format: Literal["geotiff", "csv"] = Field("geotiff", description="Output format for spatial maps.")
    spatial_aggregation: Literal["daily", "monthly", "yearly"] = Field(
        "daily", description="Temporal aggregation level for spatial maps."
    )

    # Destination folder option
    destination_folder: Optional[str] = Field(
        None, description="Optional local destination folder on disk to write files directly into."
    )


class ExportProgress(BaseModel):
    """Progress/status response for an export job."""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"] = "queued"
    progress_percent: int = Field(0, ge=0, le=100)
    message: str = ""
    files_generated: int = 0
    total_files_expected: int = 0
    download_ready: bool = False
    download_path: Optional[str] = None
    error: Optional[str] = None
