from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from .repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    workspace: Dict[str, Any] = Field(default_factory=dict)
    code: str = ""


class SaveProjectRequest(BaseModel):
    workspace: Dict[str, Any] = Field(default_factory=dict)
    code: str = ""


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)


def build_project_workspace_router(workspace_root: Path) -> APIRouter:
    router = APIRouter(prefix="/projects", tags=["projects"])
    repository = ProjectRepository(workspace_root)

    @router.get("")
    async def list_projects():
        projects = await run_in_threadpool(repository.list_projects)
        return {"projects": projects, "count": len(projects)}

    @router.post("", status_code=201)
    async def create_project(payload: CreateProjectRequest):
        try:
            return await run_in_threadpool(
                repository.create_project,
                payload.name,
                payload.description,
                payload.workspace,
                payload.code,
            )
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/{project_id}")
    async def get_project(project_id: str):
        try:
            return await run_in_threadpool(repository.get_project, project_id)
        except ProjectNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/{project_id}/exports/{filename}")
    async def get_project_export(project_id: str, filename: str):
        try:
            export_path = await run_in_threadpool(repository.get_export_path, project_id, filename)
            return FileResponse(path=str(export_path), filename=export_path.name)
        except ProjectNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Export file not found") from exc
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.put("/{project_id}/workspace")
    async def save_project(project_id: str, payload: SaveProjectRequest):
        try:
            return await run_in_threadpool(
                repository.save_project,
                project_id,
                payload.workspace,
                payload.code,
            )
        except ProjectNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.patch("/{project_id}")
    async def update_project(project_id: str, payload: UpdateProjectRequest):
        try:
            return await run_in_threadpool(
                repository.update_project,
                project_id,
                payload.name,
                payload.description,
            )
        except ProjectNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/{project_id}/archive")
    async def archive_project(project_id: str):
        try:
            project = await run_in_threadpool(repository.archive_project, project_id)
            return {"project": project, "status": "archived"}
        except ProjectNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except InvalidProjectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return router
