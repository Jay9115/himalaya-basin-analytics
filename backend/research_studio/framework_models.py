from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class ResearchVariableSpec(BaseModel):
    dataset: str = Field(..., min_length=1, max_length=120)
    variable: str = Field(..., min_length=1, max_length=180)
    aggregation: Literal["mean", "sum", "min", "max", "median"] = "mean"
    label: Optional[str] = Field(None, max_length=180)
    unit: Optional[str] = Field(None, max_length=80)
    direction: Literal["positive", "negative"] = "positive"


class ResearchFrameworkRequest(BaseModel):
    variables: List[ResearchVariableSpec] = Field(..., min_length=1, max_length=4)
    year_start: int = Field(..., ge=1900, le=2200)
    year_end: int = Field(..., ge=1900, le=2200)
    baseline_start: Optional[int] = Field(None, ge=1900, le=2200)
    baseline_end: Optional[int] = Field(None, ge=1900, le=2200)
    recent_start: Optional[int] = Field(None, ge=1900, le=2200)
    elev_min: float = Field(0, ge=-500, le=10000)
    elev_max: float = Field(9000, ge=-500, le=10000)
    subregion_id: Optional[str] = Field(None, max_length=240)
    aoi_geojson: Optional[Dict[str, Any]] = None
    methods: List[
        Literal["descriptive", "trend", "anomaly", "emergence", "change_point", "relationships", "compound"]
    ] = Field(default_factory=lambda: ["descriptive", "trend", "anomaly"])
    anomaly_threshold: float = Field(1.0, ge=0.25, le=4.0)
    emergence_threshold: float = Field(0.75, ge=0.25, le=3.0)
    emergence_window: int = Field(9, ge=5, le=15)
    persistence_fraction: float = Field(0.80, ge=0.50, le=1.0)
    max_map_points: int = Field(18000, ge=1000, le=40000)

    @model_validator(mode="after")
    def validate_request(self):
        if self.year_start > self.year_end:
            raise ValueError("year_start cannot be after year_end")
        if self.elev_min > self.elev_max:
            raise ValueError("elev_min cannot be greater than elev_max")
        if self.subregion_id and self.aoi_geojson:
            raise ValueError("Choose either a basin/glacier subregion or an ROI polygon")
        baseline_start = self.baseline_start if self.baseline_start is not None else self.year_start
        baseline_end = self.baseline_end if self.baseline_end is not None else min(self.year_end, baseline_start + 29)
        if baseline_start > baseline_end:
            raise ValueError("baseline_start cannot be after baseline_end")
        if baseline_start < self.year_start or baseline_end > self.year_end:
            raise ValueError("baseline period must be inside the analysis period")
        self.baseline_start = baseline_start
        self.baseline_end = baseline_end
        if self.recent_start is not None and not self.year_start <= self.recent_start <= self.year_end:
            raise ValueError("recent_start must be inside the analysis period")
        if self.emergence_window % 2 == 0:
            raise ValueError("emergence_window must be an odd number")
        keys = [(item.dataset, item.variable) for item in self.variables]
        if len(set(keys)) != len(keys):
            raise ValueError("Each dataset-variable pair may be selected only once")
        return self


class ResearchFrameworkFigureRequest(BaseModel):
    figure_type: Literal[
        "diagnostic_atlas",
        "timeseries",
        "relationship",
        "study_region",
        "elevation",
    ]
    run_id: Optional[str] = Field(None, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    title: Optional[str] = Field(None, max_length=180)
    include_glaciers: bool = True
    dpi: int = Field(600, ge=150, le=600)
