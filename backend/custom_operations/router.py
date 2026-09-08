import json
import re
import uuid
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from .data_access import OperationBackendHooks, OperationDataLoader, dataframe_to_worker_payload
from .large_jobs import LocalLargeOperationJobManager
from .planner import OperationExecutionPlanner
from .sandbox import LocalSubprocessSandbox
from .schemas import OperationJobCreateRequest, OperationPlanRequest, OperationRunRequest, OperationValidateRequest
from .security import ALLOWED_IMPORT_ROOTS, validate_large_operation_code, validate_python_code


JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


def build_custom_operations_router(
    *,
    hooks: OperationBackendHooks,
    workspace_root: Path,
) -> APIRouter:
    router = APIRouter(prefix="/operations", tags=["custom-operations"])
    loader = OperationDataLoader(hooks)
    planner = OperationExecutionPlanner(loader)
    sandbox = LocalSubprocessSandbox(workspace_root)
    large_jobs = LocalLargeOperationJobManager(
        loader=loader,
        planner=planner,
        workspace_root=workspace_root,
    )

    @router.get("/capabilities")
    async def get_operation_capabilities() -> Dict[str, Any]:
        return {
            "status": "available",
            "engine": "data_local_subprocess",
            "workspace_root": str(workspace_root),
            "code_limits": {
                "max_code_chars": 20000,
                "max_ast_nodes": 4000,
                "timeout_seconds": {"default": 15, "max": 60},
                "large_job_timeout_seconds": {"default": 600, "max": 86400},
                "max_rows": {"default": None, "max": None, "note": "frontend omits this; platform plans execution automatically"},
                "max_dates": {"default": None, "max": None, "note": "frontend omits this; platform plans execution automatically"},
            },
            "allowed_imports": sorted(ALLOWED_IMPORT_ROOTS),
            "provided_globals": ["data", "df", "hb", "meta", "pd", "np", "math", "statistics"],
            "hb_outputs": [
                "hb.text(value, name='text')",
                "hb.number(name, value, units=None)",
                "hb.table(data, name='table')",
                "hb.map_points(data=df, name='layer', lat='lat', lon='lon', value='value', style={...})",
                "hb.geojson(feature_collection, name='geojson', style={...})",
                "hb.chart(data, chart_type='line|bar|area|scatter|pie|histogram', ...)",
                "hb.chart_line(data, x='date', y='value', name='line_chart')",
                "hb.chart_bar(data, x='variable', y='value', name='bar_chart')",
                "hb.chart_area(data, x='date', y='value', name='area_chart')",
                "hb.chart_scatter(data, x='elev', y='value', name='scatter_chart')",
                "hb.chart_pie(data, category='variable', value='value', name='pie_chart')",
                "hb.chart_histogram(data, value='value', bins=20, name='histogram_chart')",
                "hb.export_csv(data=df, filename='analysis.csv')",
                "hb.export_json(data={'summary': ...}, filename='summary.json')",
                "hb.pivot_variables(df)",
                "large mode: hb.sql('SELECT ... FROM data'), hb.export_query('SELECT ... FROM data', filename='result.parquet', format='parquet')",
                "large mode: hb.iter_data(), hb.aggregate(by=['year'], metrics={'value': 'mean'}), hb.sample(max_rows=10000)",
            ],
            "security_notes": [
                "User code receives a normalized data relation, not raw project paths.",
                "Large Parquet selections are scanned in place; only bounded results enter pandas or cross to the UI.",
                "The local runner uses AST validation, restricted builtins/imports, subprocess isolation, output caps, and timeout.",
                "For public multi-user deployment, switch this runner behind the same API to a container or microVM sandbox.",
            ],
            "example": (
                "def run(hb, df, meta):\n"
                "    hb.text(f\"Rows: {len(df)} from {meta['dataset_label']}\")\n"
                "    daily = df.groupby('date', as_index=False)['value'].mean()\n"
                "    hb.table(daily, name='daily_mean')\n"
                "    hb.number('overall_mean', df['value'].mean(), units='dataset units')\n"
                "    hb.chart(daily, chart_type='area', x='date', y='value', name='daily_mean_area')\n"
                "    hb.map_points(\n"
                "        df,\n"
                "        name='selected_points',\n"
                "        style={'palette': 'viridis', 'radius': 4, 'opacity': 0.75},\n"
                "    )\n"
                "    hb.export_csv(daily, filename='daily_mean.csv')\n"
            ),
        }

    @router.post("/plan")
    async def plan_operation(request: OperationPlanRequest) -> Dict[str, Any]:
        return await run_in_threadpool(planner.plan, request.selection)

    @router.post("/validate")
    async def validate_operation_code(request: OperationValidateRequest) -> Dict[str, Any]:
        validation = validate_python_code(request.code)
        return {
            "ok": validation.ok,
            "errors": validation.errors,
            "warnings": validation.warnings,
        }

    @router.post("/run")
    async def run_operation(request: OperationRunRequest) -> Dict[str, Any]:
        validation = validate_python_code(request.code)
        if not validation.ok:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Custom operation code did not pass sandbox validation.",
                    "errors": validation.errors,
                    "warnings": validation.warnings,
                },
            )

        plan = await run_in_threadpool(planner.plan, request.selection)
        if not plan.get("can_run_inline"):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "Selection is too large for inline execution. Submit it to /operations/jobs.",
                    "plan": plan,
                },
            )

        frame, meta = await run_in_threadpool(loader.load_selection, request.selection)
        frame_payload = dataframe_to_worker_payload(frame)
        job_id = uuid.uuid4().hex

        result = await run_in_threadpool(
            sandbox.run,
            job_id=job_id,
            code=request.code,
            frame_payload=frame_payload,
            meta=meta,
            timeout_seconds=request.timeout_seconds,
        )
        result["validation"] = {
            "ok": validation.ok,
            "warnings": validation.warnings,
        }
        if result.get("result_path"):
            result_path = Path(str(result["result_path"]))
            result_path.write_text(json.dumps(result, indent=2, ensure_ascii=True), encoding="utf-8")
        return result

    @router.post("/jobs")
    async def create_operation_job(request: OperationJobCreateRequest) -> Dict[str, Any]:
        validation = validate_python_code(request.code)
        if not validation.ok:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Custom operation code did not pass sandbox validation.",
                    "errors": validation.errors,
                    "warnings": validation.warnings,
                },
            )
        plan = await run_in_threadpool(planner.plan, request.selection)
        compatibility = validate_large_operation_code(request.code)
        if not compatibility.ok:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Large selections require data-local lazy operations.",
                    "errors": compatibility.errors,
                    "warnings": compatibility.warnings,
                    "plan": plan,
                },
            )
        job = await run_in_threadpool(large_jobs.submit, request, plan)
        job["validation"] = {
            "ok": validation.ok,
            "warnings": validation.warnings + compatibility.warnings,
        }
        return job

    @router.get("/jobs/{job_id}")
    async def get_operation_job(job_id: str) -> Dict[str, Any]:
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id")

        try:
            return await run_in_threadpool(large_jobs.get_job, job_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Operation job not found")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not read job result: {exc}") from exc

    @router.get("/jobs/{job_id}/logs")
    async def get_operation_job_logs(job_id: str) -> Dict[str, Any]:
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id")
        try:
            return await run_in_threadpool(large_jobs.get_logs, job_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Operation job not found")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not read job logs: {exc}") from exc

    @router.post("/jobs/{job_id}/cancel")
    async def cancel_operation_job(job_id: str) -> Dict[str, Any]:
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id")
        try:
            return await run_in_threadpool(large_jobs.cancel, job_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Operation job not found")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not cancel job: {exc}") from exc

    @router.get("/jobs/{job_id}/exports/{filename}")
    async def download_operation_export(job_id: str, filename: str) -> FileResponse:
        if not JOB_ID_PATTERN.match(job_id):
            raise HTTPException(status_code=400, detail="Invalid job id")
        safe_name = Path(filename).name
        if not safe_name or safe_name != filename:
            raise HTTPException(status_code=400, detail="Invalid export filename")

        export_path = (sandbox.jobs_root / job_id / "exports" / safe_name).resolve()
        export_root = (sandbox.jobs_root / job_id / "exports").resolve()
        if export_root not in export_path.parents:
            raise HTTPException(status_code=400, detail="Invalid export filename")
        if not export_path.exists() or not export_path.is_file():
            raise HTTPException(status_code=404, detail="Export file not found")

        media_type = "application/octet-stream"
        if safe_name.lower().endswith(".csv"):
            media_type = "text/csv"
        elif safe_name.lower().endswith(".json"):
            media_type = "application/json"
        return FileResponse(path=str(export_path), filename=safe_name, media_type=media_type)

    return router
