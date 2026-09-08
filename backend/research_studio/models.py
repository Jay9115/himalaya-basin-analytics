from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class ResearchAnalysisRequest(BaseModel):
    dataset: Literal["era5_annual", "chirps_annual"] = "era5_annual"
    variable: str = "temperature_C"
    secondary_dataset: Optional[Literal["era5_annual", "chirps_annual"]] = None
    secondary_variable: Optional[str] = None
    year_start: int = Field(1981, ge=1900, le=2200)
    year_end: int = Field(2025, ge=1900, le=2200)
    baseline_start: int = Field(1981, ge=1900, le=2200)
    baseline_end: int = Field(2010, ge=1900, le=2200)
    recent_start: Optional[int] = Field(None, ge=1900, le=2200)
    elev_min: float = Field(0, ge=-500, le=10000)
    elev_max: float = Field(9000, ge=-500, le=10000)
    sector: Literal["all", "west", "central", "east"] = "all"
    basin: Optional[int] = Field(None, ge=1, le=10000)
    signal_direction: Literal["positive", "negative"] = "positive"
    secondary_direction: Literal["positive", "negative"] = "negative"
    anomaly_threshold: float = Field(1.0, ge=0.25, le=4.0)
    emergence_threshold: float = Field(0.75, ge=0.25, le=3.0)
    emergence_window: int = Field(9, ge=5, le=15)
    persistence_fraction: float = Field(0.80, ge=0.50, le=1.0)
    max_map_points: int = Field(18000, ge=1000, le=40000)

    @model_validator(mode="after")
    def validate_ranges(self):
        if self.year_start > self.year_end:
            raise ValueError("year_start cannot be after year_end")
        if self.baseline_start > self.baseline_end:
            raise ValueError("baseline_start cannot be after baseline_end")
        if self.elev_min > self.elev_max:
            raise ValueError("elev_min cannot be greater than elev_max")
        if self.emergence_window % 2 == 0:
            raise ValueError("emergence_window must be an odd number")
        if self.secondary_dataset and not self.secondary_variable:
            raise ValueError("secondary_dataset requires secondary_variable")
        return self


class ResearchFigureRequest(BaseModel):
    figure_type: Literal[
        "diagnostic_atlas",
        "timeseries",
        "study_region",
        "elevation",
    ]
    run_id: Optional[str] = None
    title: Optional[str] = Field(None, max_length=180)
    include_glaciers: bool = True
    dpi: int = Field(600, ge=150, le=600)


class ResearchExportRequest(BaseModel):
    run_id: str = Field(..., min_length=6, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
