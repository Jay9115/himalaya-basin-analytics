import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from .runtime import resolve_worker_command


@dataclass
class SandboxLimits:
    timeout_seconds: int = 15
    memory_mb: int = 512
    max_stdout_chars: int = 20000
    max_stderr_chars: int = 12000
    max_text_chars: int = 12000
    max_table_rows: int = 1000
    max_map_points: int = 20000
    max_chart_points: int = 2000
    max_result_rows: int = 250000
    max_outputs: int = 40

    def to_payload(self) -> Dict[str, Any]:
        return {
            "timeout_seconds": self.timeout_seconds,
            "memory_mb": self.memory_mb,
            "max_stdout_chars": self.max_stdout_chars,
            "max_stderr_chars": self.max_stderr_chars,
            "max_text_chars": self.max_text_chars,
            "max_table_rows": self.max_table_rows,
            "max_map_points": self.max_map_points,
            "max_chart_points": self.max_chart_points,
            "max_result_rows": self.max_result_rows,
            "max_outputs": self.max_outputs,
        }


class LocalSubprocessSandbox:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = Path(workspace_root)
        self.jobs_root = self.workspace_root / "jobs"
        self.jobs_root.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        *,
        job_id: str,
        code: str,
        frame_payload: Dict[str, Any],
        meta: Dict[str, Any],
        timeout_seconds: int,
    ) -> Dict[str, Any]:
        created_at = datetime.now(timezone.utc).isoformat()
        job_dir = self.jobs_root / job_id
        job_dir.mkdir(parents=True, exist_ok=False)

        limits = SandboxLimits(timeout_seconds=timeout_seconds)
        request_payload = {
            "job_id": job_id,
            "code": code,
            "code_sha256": hashlib.sha256(code.encode("utf-8")).hexdigest(),
            "frame": frame_payload,
            "meta": meta,
            "limits": limits.to_payload(),
            "timeout_seconds": timeout_seconds,
        }

        env = self._subprocess_env()
        started_at = datetime.now(timezone.utc)
        try:
            completed = subprocess.run(
                resolve_worker_command("sandbox"),
                input=json.dumps(request_payload, ensure_ascii=True),
                capture_output=True,
                text=True,
                cwd=str(job_dir),
                env=env,
                timeout=timeout_seconds + 2,
            )
        except subprocess.TimeoutExpired as exc:
            result = {
                "job_id": job_id,
                "status": "timeout",
                "ok": False,
                "created_at": created_at,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "duration_ms": self._duration_ms(started_at),
                "meta": meta,
                "outputs": [],
                "stdout": (exc.stdout or "")[: limits.max_stdout_chars],
                "stderr": (exc.stderr or "")[: limits.max_stderr_chars],
                "error": f"Operation timed out after {timeout_seconds} seconds.",
                "workspace": str(job_dir),
                "code_sha256": request_payload["code_sha256"],
            }
            self._write_result(job_dir, result)
            return result

        worker_payload = self._parse_worker_payload(completed.stdout)
        ok = bool(worker_payload.get("ok")) and completed.returncode == 0
        status = "completed" if ok else "error"
        result = {
            "job_id": job_id,
            "status": status,
            "ok": ok,
            "created_at": created_at,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": self._duration_ms(started_at),
            "meta": meta,
            "outputs": worker_payload.get("outputs", []),
            "stdout": worker_payload.get("stdout", ""),
            "stderr": worker_payload.get("stderr", ""),
            "error": worker_payload.get("error"),
            "worker_returncode": completed.returncode,
            "worker_stderr": completed.stderr[-4000:] if completed.stderr else "",
            "workspace": str(job_dir),
            "code_sha256": request_payload["code_sha256"],
        }
        self._write_result(job_dir, result)
        return result

    def _subprocess_env(self) -> Dict[str, str]:
        env_keys = [
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "PYTHONPATH",
        ]
        env = {key: value for key in env_keys if (value := os.environ.get(key))}
        env.update(
            {
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONNOUSERSITE": "1",
                "OMP_NUM_THREADS": "1",
                "OPENBLAS_NUM_THREADS": "1",
                "MKL_NUM_THREADS": "1",
                "NUMEXPR_NUM_THREADS": "1",
            }
        )
        return env

    def _parse_worker_payload(self, stdout: str) -> Dict[str, Any]:
        try:
            return json.loads(stdout)
        except Exception:
            return {
                "ok": False,
                "outputs": [],
                "stdout": "",
                "stderr": "",
                "error": f"Sandbox worker did not return JSON. Raw output: {stdout[-4000:]}",
            }

    def _write_result(self, job_dir: Path, result: Dict[str, Any]) -> None:
        result_path = job_dir / "result.json"
        result["result_path"] = str(result_path)
        result_path.write_text(json.dumps(result, indent=2, ensure_ascii=True), encoding="utf-8")

    def _duration_ms(self, started_at: datetime) -> float:
        return round((datetime.now(timezone.utc) - started_at).total_seconds() * 1000, 2)
