from __future__ import annotations

import json
import os
import re
import shutil
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import unquote


SCHEMA_VERSION = 1
MAX_WORKSPACE_BYTES = 20 * 1024 * 1024
PROJECT_ID_PATTERN = re.compile(r"^[a-f0-9]{12}$")
OPERATION_EXPORT_PATTERN = re.compile(r"^/operations/jobs/([^/]+)/exports/([^/]+)$")
SAFE_EXPORT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


class ProjectNotFoundError(FileNotFoundError):
    pass


class InvalidProjectError(ValueError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ProjectRepository:
    """Small, atomic, filesystem-backed repository.

    Project files are deliberately separate from analytical data and job output.
    A save only writes compact configuration state and the current code document.
    """

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.projects_root = self.root / "projects"
        self.archive_root = self.root / "archive"
        self._lock = threading.RLock()

    def ensure_ready(self) -> None:
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self.archive_root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _clean_text(value: Any, field: str, max_length: int, required: bool = False) -> str:
        text = str(value or "").strip()
        if required and not text:
            raise InvalidProjectError(f"{field} is required")
        if len(text) > max_length:
            raise InvalidProjectError(f"{field} must be {max_length} characters or fewer")
        return text

    def _project_dir(self, project_id: str) -> Path:
        if not PROJECT_ID_PATTERN.fullmatch(project_id or ""):
            raise InvalidProjectError("Invalid project id")
        project_dir = (self.projects_root / project_id).resolve()
        if project_dir.parent != self.projects_root:
            raise InvalidProjectError("Invalid project path")
        return project_dir

    @staticmethod
    def _read_json(path: Path) -> Dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InvalidProjectError(f"Cannot read project file: {path.name}") from exc
        if not isinstance(value, dict):
            raise InvalidProjectError(f"Project file must contain an object: {path.name}")
        return value

    @staticmethod
    def _atomic_write_text(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temp_path.write_text(text, encoding="utf-8", newline="\n")
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)

    @classmethod
    def _atomic_write_json(cls, path: Path, value: Dict[str, Any]) -> None:
        payload = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        cls._atomic_write_text(path, payload)

    def _metadata(self, project_dir: Path) -> Dict[str, Any]:
        metadata_path = project_dir / "project.json"
        if not metadata_path.exists():
            raise ProjectNotFoundError(project_dir.name)
        return self._read_json(metadata_path)

    @staticmethod
    def _project_file(project_dir: Path, value: Any, fallback: str) -> Path:
        filename = str(value or fallback)
        file_path = (project_dir / filename).resolve()
        if file_path.parent != project_dir.resolve():
            raise InvalidProjectError("Project metadata contains an invalid file path")
        return file_path

    @staticmethod
    def _safe_export_filename(job_id: str, filename: str) -> str:
        job = SAFE_EXPORT_PATTERN.sub("_", unquote(str(job_id or "job"))).strip("._") or "job"
        name = SAFE_EXPORT_PATTERN.sub("_", unquote(str(filename or "export"))).strip("._") or "export"
        return f"{job}-{name}"[:180]

    def _copy_operation_export(self, project_dir: Path, job_id: str, filename: str) -> str | None:
        safe_source_name = Path(unquote(filename)).name
        jobs_root = (self.root / "custom_operations" / "jobs").resolve()
        source_root = (jobs_root / unquote(job_id) / "exports").resolve()
        if source_root.parent.parent != jobs_root:
            return None
        source_path = (source_root / safe_source_name).resolve()
        if source_path.parent != source_root or not source_path.exists() or not source_path.is_file():
            return None

        exports_dir = (project_dir / "exports").resolve()
        if exports_dir.parent != project_dir.resolve():
            raise InvalidProjectError("Invalid project export path")
        exports_dir.mkdir(parents=True, exist_ok=True)
        export_name = self._safe_export_filename(job_id, safe_source_name)
        destination = (exports_dir / export_name).resolve()
        if destination.parent != exports_dir:
            raise InvalidProjectError("Invalid project export filename")
        shutil.copy2(source_path, destination)
        return f"/projects/{project_dir.name}/exports/{export_name}"

    def _snapshot_result_exports(self, project_dir: Path, result: Any) -> None:
        if not isinstance(result, dict):
            return
        outputs = result.get("outputs")
        if not isinstance(outputs, list):
            return
        for output in outputs:
            if not isinstance(output, dict) or output.get("type") != "export_file":
                continue
            download_url = str(output.get("download_url") or "")
            match = OPERATION_EXPORT_PATTERN.fullmatch(download_url)
            if not match:
                continue
            project_url = self._copy_operation_export(project_dir, match.group(1), match.group(2))
            if project_url:
                output["download_url"] = project_url

    def _snapshot_code_artifacts(self, project_dir: Path, workspace: Dict[str, Any]) -> None:
        code_state = workspace.get("tools", {}).get("code") if isinstance(workspace.get("tools"), dict) else None
        if not isinstance(code_state, dict):
            return
        self._snapshot_result_exports(project_dir, code_state.get("result"))
        files = code_state.get("files")
        if not isinstance(files, list):
            return
        for file_state in files:
            if isinstance(file_state, dict):
                self._snapshot_result_exports(project_dir, file_state.get("result"))

    def list_projects(self) -> List[Dict[str, Any]]:
        self.ensure_ready()
        projects: List[Dict[str, Any]] = []
        with self._lock:
            for entry in self.projects_root.iterdir():
                if not entry.is_dir() or not PROJECT_ID_PATTERN.fullmatch(entry.name):
                    continue
                try:
                    projects.append(self._metadata(entry))
                except InvalidProjectError:
                    continue
        return sorted(projects, key=lambda item: item.get("updated_at", ""), reverse=True)

    def create_project(
        self,
        name: str,
        description: str = "",
        workspace: Dict[str, Any] | None = None,
        code: str = "",
    ) -> Dict[str, Any]:
        self.ensure_ready()
        clean_name = self._clean_text(name, "Project name", 120, required=True)
        clean_description = self._clean_text(description, "Description", 500)
        clean_code = str(code or "")
        workspace_value = deepcopy(workspace) if isinstance(workspace, dict) else {}
        project_id = uuid.uuid4().hex[:12]
        created_at = utc_now()
        metadata = {
            "schema_version": SCHEMA_VERSION,
            "id": project_id,
            "name": clean_name,
            "description": clean_description,
            "created_at": created_at,
            "updated_at": created_at,
            "last_opened_at": created_at,
            "workspace_file": "workspace.json",
            "code_file": "code.py",
        }
        project_dir = self._project_dir(project_id)
        with self._lock:
            project_dir.mkdir(parents=False, exist_ok=False)
            try:
                self._write_workspace(project_dir, workspace_value, clean_code, created_at)
                self._atomic_write_json(project_dir / "project.json", metadata)
            except Exception:
                for file_path in project_dir.iterdir():
                    file_path.unlink(missing_ok=True)
                project_dir.rmdir()
                raise
        return self.get_project(project_id, touch=False)

    def _write_workspace(
        self,
        project_dir: Path,
        workspace: Dict[str, Any],
        code: str,
        saved_at: str,
    ) -> None:
        state = deepcopy(workspace)
        state.pop("code", None)
        self._snapshot_code_artifacts(project_dir, state)
        document = {
            "schema_version": SCHEMA_VERSION,
            "saved_at": saved_at,
            "state": state,
            "documents": {"code": "code.py"},
        }
        serialized = json.dumps(document, ensure_ascii=False)
        if len(serialized.encode("utf-8")) > MAX_WORKSPACE_BYTES:
            raise InvalidProjectError("Workspace state is too large to save")
        self._atomic_write_text(project_dir / "code.py", str(code or ""))
        self._atomic_write_json(project_dir / "workspace.json", document)

    def get_project(self, project_id: str, touch: bool = True) -> Dict[str, Any]:
        project_dir = self._project_dir(project_id)
        with self._lock:
            metadata = self._metadata(project_dir)
            workspace_path = self._project_file(project_dir, metadata.get("workspace_file"), "workspace.json")
            workspace_document = self._read_json(workspace_path)
            code_path = self._project_file(project_dir, metadata.get("code_file"), "code.py")
            code = code_path.read_text(encoding="utf-8") if code_path.exists() else ""
            if touch:
                metadata["last_opened_at"] = utc_now()
                self._atomic_write_json(project_dir / "project.json", metadata)
            return {
                "project": metadata,
                "workspace": workspace_document.get("state", {}),
                "code": code,
            }

    def save_project(self, project_id: str, workspace: Dict[str, Any], code: str) -> Dict[str, Any]:
        if not isinstance(workspace, dict):
            raise InvalidProjectError("Workspace state must be an object")
        project_dir = self._project_dir(project_id)
        saved_at = utc_now()
        with self._lock:
            metadata = self._metadata(project_dir)
            self._write_workspace(project_dir, workspace, str(code or ""), saved_at)
            metadata["updated_at"] = saved_at
            self._atomic_write_json(project_dir / "project.json", metadata)
        return self.get_project(project_id, touch=False)

    def get_export_path(self, project_id: str, filename: str) -> Path:
        project_dir = self._project_dir(project_id)
        safe_name = Path(unquote(filename or "")).name
        export_root = (project_dir / "exports").resolve()
        export_path = (export_root / safe_name).resolve()
        if export_path.parent != export_root:
            raise InvalidProjectError("Invalid export filename")
        if not export_path.exists() or not export_path.is_file():
            raise ProjectNotFoundError(project_id)
        return export_path

    def update_project(self, project_id: str, name: str | None, description: str | None) -> Dict[str, Any]:
        project_dir = self._project_dir(project_id)
        with self._lock:
            metadata = self._metadata(project_dir)
            if name is not None:
                metadata["name"] = self._clean_text(name, "Project name", 120, required=True)
            if description is not None:
                metadata["description"] = self._clean_text(description, "Description", 500)
            metadata["updated_at"] = utc_now()
            self._atomic_write_json(project_dir / "project.json", metadata)
        return metadata

    def archive_project(self, project_id: str) -> Dict[str, Any]:
        project_dir = self._project_dir(project_id)
        with self._lock:
            metadata = self._metadata(project_dir)
            archived_at = utc_now()
            metadata["archived_at"] = archived_at
            self._atomic_write_json(project_dir / "project.json", metadata)
            destination = (self.archive_root / f"{project_id}-{archived_at.replace(':', '')}").resolve()
            if destination.parent != self.archive_root:
                raise InvalidProjectError("Invalid archive path")
            os.replace(project_dir, destination)
        return metadata
