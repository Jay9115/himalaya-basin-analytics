from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class OperationSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset: Optional[str] = Field(None, description="Dataset id. Defaults to app default dataset.")
    date: Optional[str] = Field(None, description="Single date in YYYY-MM-DD or DD-MM-YYYY format.")
    start_date: Optional[str] = Field(None, description="Inclusive start date in YYYY-MM-DD or DD-MM-YYYY format.")
    end_date: Optional[str] = Field(None, description="Inclusive end date in YYYY-MM-DD or DD-MM-YYYY format.")
    dates: Optional[List[str]] = Field(None, description="Explicit list of dates in YYYY-MM-DD or DD-MM-YYYY format.")
    variable: Optional[str] = Field(None, description="Primary variable name.")
    variables: Optional[List[str]] = Field(None, description="One or more variable names.")
    elev_min: Optional[float] = Field(None, description="Minimum elevation.")
    elev_max: Optional[float] = Field(None, description="Maximum elevation.")
    subregion_id: Optional[str] = Field(None, description="Optional basin/glacier subregion id.")
    year_start: Optional[int] = Field(None, description="Optional inclusive index start year.")
    year_end: Optional[int] = Field(None, description="Optional inclusive index end year.")
    max_rows: Optional[int] = Field(None, ge=1, description="Optional maximum rows delivered to code.")
    max_dates: Optional[int] = Field(None, ge=1, description="Optional maximum indexed dates delivered to code.")


class OperationValidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(..., min_length=1, max_length=20000)


class OperationRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(..., min_length=1, max_length=20000)
    selection: OperationSelection = Field(default_factory=OperationSelection)
    timeout_seconds: int = Field(15, ge=1, le=60)
    engine: Literal["local_subprocess"] = "local_subprocess"


class OperationPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selection: OperationSelection = Field(default_factory=OperationSelection)


class OperationJobCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(..., min_length=1, max_length=20000)
    selection: OperationSelection = Field(default_factory=OperationSelection)
    timeout_seconds: int = Field(600, ge=1, le=86400)
    memory_mb: int = Field(1024, ge=128, le=8192)
    engine: Literal["large_subprocess"] = "large_subprocess"


class OperationJobSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    status: str
    created_at: str
    finished_at: Optional[str] = None
    selection: Dict[str, Any]
    result_path: Optional[str] = None

