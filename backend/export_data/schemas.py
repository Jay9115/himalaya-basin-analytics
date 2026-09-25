"""Pydantic schemas for the Export Data module."""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExportRequest(BaseModel):
    """Request payload for starting a data export job."""

    model_config = ConfigDict(extra="forbid")

    dataset: Optional[str] = Field(None, description="Dataset id. Defaults to app default dataset.")
    variables: List[str] = Field(default_factory=list, description="One or more variable names to export.")
    dataset_variables: Optional[Dict[str, List[str]]] = Field(
        None, description="Optional mapping of dataset_id -> list of variables for cross-dataset export."
    )
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

    @model_validator(mode="after")
    def check_at_least_one_variable(self) -> "ExportRequest":
        has_vars = bool(self.variables and len(self.variables) > 0)
        has_ds_vars = bool(
            self.dataset_variables and any(v for v in self.dataset_variables.values() if v)
        )
        if not has_vars and not has_ds_vars:
            raise ValueError("Select at least one variable to export.")
        return self

    def resolve_dataset_variables(self, default_dataset: str = "default") -> Dict[str, List[str]]:
        """
        Returns a normalized mapping of {dataset_id: [var1, var2, ...]}
        resolving from dataset_variables, variables, and dataset fallback.
        """
        result: Dict[str, List[str]] = {}

        if self.dataset_variables:
            for ds, var_list in self.dataset_variables.items():
                ds_clean = (ds or "").strip()
                if ds_clean:
                    cleaned_vars = [v.strip() for v in var_list if v and v.strip()]
                    if cleaned_vars:
                        result.setdefault(ds_clean, []).extend(cleaned_vars)

        primary_dataset = (self.dataset or default_dataset or "default").strip()
        for item in self.variables:
            item_clean = item.strip()
            if not item_clean:
                continue
            if ":" in item_clean:
                ds_part, var_part = item_clean.split(":", 1)
                ds_target = ds_part.strip() or primary_dataset
                var_target = var_part.strip()
            else:
                ds_target = primary_dataset
                var_target = item_clean

            if var_target:
                curr_list = result.setdefault(ds_target, [])
                if var_target not in curr_list:
                    curr_list.append(var_target)

        # Remove duplicate variables while preserving insertion order
        deduped: Dict[str, List[str]] = {}
        for ds, v_list in result.items():
            seen = set()
            clean_list = []
            for v in v_list:
                if v not in seen:
                    seen.add(v)
                    clean_list.append(v)
            if clean_list:
                deduped[ds] = clean_list

        return deduped


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
