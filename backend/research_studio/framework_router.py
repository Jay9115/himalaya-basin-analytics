from __future__ import annotations

import asyncio
import logging
import mimetypes
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from custom_operations.data_access import OperationDataLoader

from .framework_analysis import ResearchFrameworkService
from .framework_figures import ResearchFrameworkFigureService
from .framework_models import ResearchFrameworkFigureRequest, ResearchFrameworkRequest


logger = logging.getLogger(__name__)


def build_research_framework_router(app_root: Path, loader: OperationDataLoader) -> APIRouter:
    router = APIRouter(prefix="/research/framework", tags=["research-framework"])
    service = ResearchFrameworkService(app_root, loader)
    figures = ResearchFrameworkFigureService(app_root, service)
    analysis_slot = asyncio.Semaphore(1)
    figure_slot = asyncio.Semaphore(1)

    @router.get("/capabilities")
    async def get_capabilities() -> Dict[str, Any]:
        return service.capabilities()

    @router.post("/analyze")
    async def run_analysis(request: ResearchFrameworkRequest) -> Dict[str, Any]:
        try:
            async with analysis_slot:
                return await run_in_threadpool(service.analyze, request)
        except (ValueError, KeyError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("General research-framework analysis failed")
            raise HTTPException(status_code=500, detail=f"Research analysis failed: {exc}") from exc

    @router.post("/figures")
    async def create_figure(request: ResearchFrameworkFigureRequest) -> Dict[str, Any]:
        if request.figure_type in {"diagnostic_atlas", "timeseries", "relationship"} and not request.run_id:
            raise HTTPException(status_code=400, detail="This figure type requires a completed analysis run")
        try:
            async with figure_slot:
                return await run_in_threadpool(figures.create, request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("General research-framework figure creation failed")
            raise HTTPException(status_code=500, detail=f"Figure creation failed: {exc}") from exc

    @router.get("/runs/{run_id}")
    async def get_run(run_id: str) -> FileResponse:
        try:
            summary = service.run_dir(run_id) / "summary.json"
            if not summary.is_file():
                raise FileNotFoundError("Run summary not found")
            return FileResponse(summary, media_type="application/json")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get("/runs/{run_id}/{artifact_path:path}")
    async def download_artifact(run_id: str, artifact_path: str) -> FileResponse:
        try:
            run_dir = service.run_dir(run_id)
            artifact = (run_dir / artifact_path).resolve()
            if run_dir not in artifact.parents or not artifact.is_file():
                raise FileNotFoundError("Research artifact not found")
            allowed_top_level = {
                "annual_series.csv",
                "pixel_metrics.parquet",
                "relationships.csv",
                "summary.json",
                "request.json",
            }
            allowed_figure_extensions = {".png", ".pdf", ".tif", ".tiff"}
            allowed = artifact.name in allowed_top_level or (
                artifact.parent == run_dir / "figures" and artifact.suffix.lower() in allowed_figure_extensions
            )
            if not allowed:
                raise FileNotFoundError("Research artifact not found")
            media_type = mimetypes.guess_type(artifact.name)[0] or "application/octet-stream"
            return FileResponse(artifact, media_type=media_type)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return router

