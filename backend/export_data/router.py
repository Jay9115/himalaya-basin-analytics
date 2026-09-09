"""
FastAPI router for the Export Data module.

Prefix: /export
Endpoints:
    POST /export/start       — Start an export job
    GET  /export/status/{id} — Poll job progress
    GET  /export/download/{id} — Download the finished ZIP
    POST /export/cancel/{id} — Cancel a running job
"""

import re
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from custom_operations.data_access import OperationBackendHooks

from .schemas import ExportProgress, ExportRequest
from .worker import (
    cancel_job,
    get_job_files,
    get_job_output_dir,
    get_job_progress,
    run_export,
)


JOB_ID_PATTERN = re.compile(r"^exp_[a-f0-9]{12}$")


def build_export_router(
    *,
    hooks: OperationBackendHooks,
    workspace_root: Path,
) -> APIRouter:
    """
    Factory that creates the /export router.

    Parameters
    ----------
    hooks : OperationBackendHooks
        Callbacks to the main application's data access layer (same hooks
        used by custom_operations).
    workspace_root : Path
        Directory where export job output files are staged and ZIPs are stored.
    """
    router = APIRouter(prefix="/export", tags=["export-data"])

    workspace_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # POST /export/start
    # ------------------------------------------------------------------
    @router.post("/start")
    async def start_export(request: ExportRequest) -> Dict[str, Any]:
        """Validate the request and launch a background export job."""
        if not request.export_temporal_csv and not request.export_spatial_maps:
            raise HTTPException(
                status_code=400,
                detail="Select at least one export type (temporal CSV or spatial maps).",
            )
        if not request.variables:
            raise HTTPException(
                status_code=400,
                detail="Select at least one variable to export.",
            )

        # Light validation — ensure dataset + variables exist before spawning
        year_start, year_end = hooks.normalize_year_range(
            request.year_start, request.year_end
        )
        state = hooks.ensure_dataset_loaded(
            request.dataset, year_start=year_start, year_end=year_end
        )
        all_known = set(state.get("variables", [])).union(state.get("all_columns", []))
        for variable in request.variables:
            if variable not in all_known:
                hooks.validate_variable(state, variable)

        job_id = await run_in_threadpool(
            run_export, request, hooks, workspace_root
        )
        return {"job_id": job_id, "status": "queued"}

    # ------------------------------------------------------------------
    # GET /export/status/{job_id}
    # ------------------------------------------------------------------
    @router.get("/status/{job_id}")
    async def export_status(job_id: str) -> Dict[str, Any]:
        """Return current progress of an export job."""
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id format.")
        progress = get_job_progress(job_id)
        if progress is None:
            raise HTTPException(status_code=404, detail=f"Export job '{job_id}' not found.")
        return progress.model_dump()

    # ------------------------------------------------------------------
    # GET /export/download/{job_id}
    # ------------------------------------------------------------------
    @router.get("/download/{job_id}")
    async def download_export(job_id: str):
        """Download the ZIP file for a completed export job."""
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id format.")
        progress = get_job_progress(job_id)
        if progress is None:
            raise HTTPException(status_code=404, detail=f"Export job '{job_id}' not found.")
        if not progress.download_ready or not progress.download_path:
            raise HTTPException(
                status_code=409,
                detail=f"Export job '{job_id}' is not ready for download (status: {progress.status}).",
            )
        zip_path = Path(progress.download_path)
        if not zip_path.exists():
            raise HTTPException(status_code=404, detail="Export file not found on disk.")
        return FileResponse(
            path=str(zip_path),
            media_type="application/zip",
            filename=zip_path.name,
        )

    # ------------------------------------------------------------------
    # GET /export/files/{job_id}
    # ------------------------------------------------------------------
    @router.get("/files/{job_id}")
    async def list_export_files(job_id: str) -> Dict[str, Any]:
        """List all generated files for direct folder saving."""
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id format.")
        progress = get_job_progress(job_id)
        if progress is None:
            raise HTTPException(status_code=404, detail=f"Export job '{job_id}' not found.")
        if progress.status != "completed":
            raise HTTPException(
                status_code=409,
                detail=f"Export job '{job_id}' is not completed yet (status: {progress.status}).",
            )
        files = get_job_files(job_id) or []
        return {"job_id": job_id, "files": files, "total_files": len(files)}

    # ------------------------------------------------------------------
    # GET /export/file/{job_id}
    # ------------------------------------------------------------------
    @router.get("/file/{job_id}")
    async def get_export_file(job_id: str, file_path: str):
        """Fetch a single generated file by relative path for browser streaming."""
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id format.")
        output_dir = get_job_output_dir(job_id)
        if output_dir is None or not output_dir.exists():
            raise HTTPException(status_code=404, detail="Export output directory not found.")

        clean_rel = Path(file_path.strip().replace("\\", "/"))
        if clean_rel.is_absolute() or ".." in clean_rel.parts:
            raise HTTPException(status_code=400, detail="Invalid file path.")

        target = (output_dir / clean_rel).resolve()
        if not str(target).startswith(str(output_dir.resolve())):
            raise HTTPException(status_code=403, detail="Access denied.")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found.")

        media_type = "application/octet-stream"
        if target.suffix == ".csv":
            media_type = "text/csv; charset=utf-8"
        elif target.suffix in (".tif", ".tiff"):
            media_type = "image/tiff"
        elif target.suffix == ".json":
            media_type = "application/json"

        return FileResponse(
            path=str(target),
            media_type=media_type,
            filename=target.name,
        )

    # ------------------------------------------------------------------
    # POST /export/cancel/{job_id}
    # ------------------------------------------------------------------
    @router.post("/cancel/{job_id}")
    async def cancel_export(job_id: str) -> Dict[str, Any]:
        """Request cancellation of a running export job."""
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id format.")
        cancelled = cancel_job(job_id)
        if not cancelled:
            raise HTTPException(status_code=404, detail=f"Export job '{job_id}' not found.")
        return {"job_id": job_id, "status": "cancelled"}

    return router
