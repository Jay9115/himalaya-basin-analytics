from __future__ import annotations

import asyncio
import logging
import mimetypes
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from .analysis import ResearchService
from .figures import FigureService
from .models import ResearchAnalysisRequest, ResearchFigureRequest


logger = logging.getLogger(__name__)


def build_research_router(app_root: Path) -> APIRouter:
    router = APIRouter(prefix="/research", tags=["research-studio"])
    service = ResearchService(app_root)
    figures = FigureService(app_root, service)
    analysis_slot = asyncio.Semaphore(1)
    figure_slot = asyncio.Semaphore(1)

    @router.get("/capabilities")
    async def get_capabilities() -> Dict[str, Any]:
        try:
            return await run_in_threadpool(service.capabilities)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @router.post("/analyze")
    async def run_analysis(request: ResearchAnalysisRequest) -> Dict[str, Any]:
        try:
            # These computations are memory-intensive; one analysis at a time
            # keeps a desktop deployment responsive and predictable.
            async with analysis_slot:
                return await run_in_threadpool(service.analyze, request)
        except (ValueError, KeyError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Research Studio analysis failed")
            raise HTTPException(status_code=500, detail=f"Research analysis failed: {exc}") from exc

    @router.post("/figures")
    async def create_figure(request: ResearchFigureRequest) -> Dict[str, Any]:
        if request.figure_type in {"diagnostic_atlas", "timeseries"} and not request.run_id:
            raise HTTPException(status_code=400, detail="This figure type requires a completed analysis run")
        try:
            async with figure_slot:
                return await run_in_threadpool(figures.create, request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Research Studio figure creation failed")
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
            allowed_top_level = {"annual_series.csv", "pixel_metrics.parquet", "summary.json", "request.json"}
            allowed_figure_extensions = {".png", ".pdf", ".tif", ".tiff"}
            is_allowed = artifact.name in allowed_top_level or (
                artifact.parent == run_dir / "figures" and artifact.suffix.lower() in allowed_figure_extensions
            )
            if not is_allowed:
                raise FileNotFoundError("Research artifact not found")
            media_type = mimetypes.guess_type(artifact.name)[0] or "application/octet-stream"
            return FileResponse(artifact, media_type=media_type)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return router
