import hashlib
import json
import subprocess
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .data_access import OperationDataLoader
from .planner import OperationExecutionPlanner
from .runtime import resolve_worker_command
from .sandbox import SandboxLimits
from .schemas import OperationJobCreateRequest


TERMINAL_STATUSES = {"completed", "error", "canceled"}


class LocalLargeOperationJobManager:
    def __init__(
        self,
        *,
        loader: OperationDataLoader,
        planner: OperationExecutionPlanner,
        workspace_root: Path,
        max_workers: int = 2,
    ) -> None:
        self.loader = loader
        self.planner = planner
        self.workspace_root = Path(workspace_root)
        self.jobs_root = self.workspace_root / "jobs"
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=max(1, int(max_workers or 1)))
        self.cancel_events: Dict[str, threading.Event] = {}
        self.processes: Dict[str, subprocess.Popen[str]] = {}
        self.lock = threading.Lock()

    def submit(self, request: OperationJobCreateRequest, plan: Dict[str, Any]) -> Dict[str, Any]:
        job_id = uuid.uuid4().hex
        job_dir = self.jobs_root / job_id
        job_dir.mkdir(parents=True, exist_ok=False)
        created_at = self._now()
        code_sha256 = hashlib.sha256(request.code.encode("utf-8")).hexdigest()
        cancel_event = threading.Event()

        state = {
            "job_id": job_id,
            "status": "queued",
            "ok": True,
            "created_at": created_at,
            "finished_at": None,
            "duration_ms": 0,
            "engine": "large_subprocess",
            "selection": self._selection_payload(request),
            "plan": plan,
            "progress": {
                "phase": "queued",
                "dates_processed": 0,
                "date_count": plan.get("selection", {}).get("date_count", 0),
                "rows_materialized": 0,
                "chunk_count": 0,
            },
            "outputs": [],
            "stdout": "",
            "stderr": "",
            "error": "",
            "meta": {},
            "workspace": str(job_dir),
            "code_sha256": code_sha256,
        }
        (job_dir / "code.py").write_text(request.code, encoding="utf-8")
        self._write_json(job_dir / "job.json", state)
        self._append_log(job_dir, "queued large operation job")

        with self.lock:
            self.cancel_events[job_id] = cancel_event
        self.executor.submit(self._run_job, job_id, request, plan, cancel_event)
        return state

    def get_job(self, job_id: str) -> Dict[str, Any]:
        job_dir = self.jobs_root / job_id
        result_path = job_dir / "result.json"
        job_path = job_dir / "job.json"
        if result_path.exists():
            return json.loads(result_path.read_text(encoding="utf-8"))
        if job_path.exists():
            return json.loads(job_path.read_text(encoding="utf-8"))
        raise FileNotFoundError(job_id)

    def get_logs(self, job_id: str) -> Dict[str, Any]:
        job_dir = self.jobs_root / job_id
        log_path = job_dir / "logs.txt"
        if not job_dir.exists():
            raise FileNotFoundError(job_id)
        return {
            "job_id": job_id,
            "logs": log_path.read_text(encoding="utf-8") if log_path.exists() else "",
        }

    def cancel(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            event = self.cancel_events.get(job_id)
            process = self.processes.get(job_id)
        if event:
            event.set()
        if process and process.poll() is None:
            process.terminate()
        job = self.get_job(job_id)
        if job.get("status") not in TERMINAL_STATUSES:
            job["status"] = "canceled"
            job["ok"] = False
            job["finished_at"] = self._now()
            job["error"] = "Operation canceled by user."
            self._finish(job_id, job)
        return self.get_job(job_id)

    def _run_job(
        self,
        job_id: str,
        request: OperationJobCreateRequest,
        plan: Dict[str, Any],
        cancel_event: threading.Event,
    ) -> None:
        job_dir = self.jobs_root / job_id
        started_at = datetime.now(timezone.utc)
        try:
            self._update(job_id, status="materializing", progress={"phase": "materializing"})
            manifest = self._materialize_chunks(job_id, request, plan, cancel_event)
            if cancel_event.is_set():
                raise OperationCanceled("Operation canceled before worker execution.")
            result = self._run_worker(job_id, request, manifest, started_at, cancel_event)
        except OperationCanceled as exc:
            result = self._base_result(job_id, request, started_at, status="canceled", ok=False)
            result["error"] = str(exc)
            self._append_log(job_dir, str(exc))
        except Exception:
            result = self._base_result(job_id, request, started_at, status="error", ok=False)
            result["error"] = traceback.format_exc(limit=10)
            self._append_log(job_dir, result["error"])
        finally:
            with self.lock:
                self.cancel_events.pop(job_id, None)
                self.processes.pop(job_id, None)

        self._finish(job_id, result)

    def _materialize_chunks(
        self,
        job_id: str,
        request: OperationJobCreateRequest,
        plan: Dict[str, Any],
        cancel_event: threading.Event,
    ) -> Dict[str, Any]:
        job_dir = self.jobs_root / job_id
        input_dir = job_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        chunks = []
        rows_materialized = 0
        dates_processed = 0
        date_count = int(plan.get("selection", {}).get("date_count") or 0)
        dates_per_chunk = int(plan.get("policy", {}).get("large_dates_per_chunk") or 30)

        for frame, chunk_meta in self.loader.iter_selection_frames(
            request.selection,
            dates_per_chunk=dates_per_chunk,
        ):
            if cancel_event.is_set():
                raise OperationCanceled("Operation canceled during data materialization.")

            dates_processed += int(chunk_meta.get("chunk_date_count") or 0)
            if frame.empty:
                self._update(
                    job_id,
                    status="materializing",
                    progress={
                        "phase": "materializing",
                        "dates_processed": dates_processed,
                        "date_count": date_count,
                        "rows_materialized": rows_materialized,
                        "chunk_count": len(chunks),
                    },
                )
                continue

            chunk_path = input_dir / f"chunk_{len(chunks):05d}.parquet"
            frame.to_parquet(chunk_path, index=False)
            rows_materialized += int(len(frame))
            chunks.append(
                {
                    "index": len(chunks),
                    "path": str(chunk_path),
                    "row_count": int(len(frame)),
                    "date_start": chunk_meta.get("chunk_date_start"),
                    "date_end": chunk_meta.get("chunk_date_end"),
                    "date_count": chunk_meta.get("chunk_date_count"),
                    "columns": list(frame.columns),
                }
            )
            self._append_log(job_dir, f"materialized {chunk_path.name}: {len(frame)} rows")
            self._update(
                job_id,
                status="materializing",
                progress={
                    "phase": "materializing",
                    "dates_processed": dates_processed,
                    "date_count": date_count,
                    "rows_materialized": rows_materialized,
                    "chunk_count": len(chunks),
                },
            )

        manifest = {
            "job_id": job_id,
            "chunks": chunks,
            "meta": {
                **plan.get("selection", {}),
                "mode": "large",
                "row_count": rows_materialized,
                "chunk_count": len(chunks),
                "dates_per_chunk": dates_per_chunk,
            },
        }
        manifest_path = job_dir / "manifest.json"
        self._write_json(manifest_path, manifest)
        self._append_log(job_dir, f"materialization finished: {rows_materialized} rows in {len(chunks)} chunks")
        return manifest

    def _run_worker(
        self,
        job_id: str,
        request: OperationJobCreateRequest,
        manifest: Dict[str, Any],
        started_at: datetime,
        cancel_event: threading.Event,
    ) -> Dict[str, Any]:
        job_dir = self.jobs_root / job_id
        manifest_path = job_dir / "manifest.json"
        progress_path = job_dir / "worker_progress.json"
        limits = SandboxLimits(
            timeout_seconds=request.timeout_seconds,
            memory_mb=request.memory_mb,
        )
        payload = {
            "job_id": job_id,
            "code": request.code,
            "manifest_path": str(manifest_path),
            "progress_path": str(progress_path),
            "meta": manifest.get("meta", {}),
            "limits": limits.to_payload(),
            "timeout_seconds": request.timeout_seconds,
        }
        self._update(
            job_id,
            status="running",
            progress={
                "phase": "worker_started",
                "dates_processed": int(manifest.get("meta", {}).get("date_count") or 0),
                "date_count": int(manifest.get("meta", {}).get("date_count") or 0),
                "rows_materialized": int(manifest.get("meta", {}).get("row_count") or 0),
                "chunk_count": len(manifest.get("chunks", [])),
            },
        )

        process = subprocess.Popen(
            resolve_worker_command("large"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(job_dir),
            env=self._subprocess_env(),
        )
        if process.stdin is not None:
            process.stdin.write(json.dumps(payload, ensure_ascii=True))
            process.stdin.close()
            process.stdin = None
        with self.lock:
            self.processes[job_id] = process

        deadline = time.monotonic() + request.timeout_seconds + 2
        last_progress = ""
        while process.poll() is None:
            if cancel_event.is_set():
                process.terminate()
                raise OperationCanceled("Operation canceled during worker execution.")
            if time.monotonic() > deadline:
                process.terminate()
                raise TimeoutError(f"Large operation timed out after {request.timeout_seconds} seconds.")
            if progress_path.exists():
                progress_text = progress_path.read_text(encoding="utf-8")
                if progress_text and progress_text != last_progress:
                    last_progress = progress_text
                    try:
                        worker_progress = json.loads(progress_text)
                    except Exception:
                        worker_progress = {"phase": "worker_running"}
                    self._update(
                        job_id,
                        status="running",
                        progress={
                            **worker_progress,
                            "rows_materialized": int(manifest.get("meta", {}).get("row_count") or 0),
                        },
                    )
            time.sleep(0.35)

        stdout, stderr = process.communicate()
        worker_payload = self._parse_worker_payload(stdout)
        ok = bool(worker_payload.get("ok")) and process.returncode == 0
        status = "completed" if ok else "error"
        result = self._base_result(job_id, request, started_at, status=status, ok=ok)
        result.update(
            {
                "meta": manifest.get("meta", {}),
                "outputs": worker_payload.get("outputs", []),
                "stdout": worker_payload.get("stdout", ""),
                "stderr": worker_payload.get("stderr", ""),
                "error": worker_payload.get("error", ""),
                "worker_returncode": process.returncode,
                "worker_stderr": stderr[-4000:] if stderr else "",
                "progress": {
                    "phase": status,
                    "dates_processed": int(manifest.get("meta", {}).get("date_count") or 0),
                    "date_count": int(manifest.get("meta", {}).get("date_count") or 0),
                    "rows_materialized": int(manifest.get("meta", {}).get("row_count") or 0),
                    "chunk_count": len(manifest.get("chunks", [])),
                    "percent": 100 if ok else None,
                },
            }
        )
        self._append_log(job_dir, f"worker finished with return code {process.returncode}")
        return result

    def _base_result(
        self,
        job_id: str,
        request: OperationJobCreateRequest,
        started_at: datetime,
        *,
        status: str,
        ok: bool,
    ) -> Dict[str, Any]:
        job_dir = self.jobs_root / job_id
        return {
            "job_id": job_id,
            "status": status,
            "ok": ok,
            "created_at": started_at.isoformat(),
            "finished_at": self._now(),
            "duration_ms": self._duration_ms(started_at),
            "engine": "large_subprocess",
            "selection": self._selection_payload(request),
            "outputs": [],
            "stdout": "",
            "stderr": "",
            "error": "",
            "meta": {},
            "workspace": str(job_dir),
            "code_sha256": hashlib.sha256(request.code.encode("utf-8")).hexdigest(),
        }

    def _parse_worker_payload(self, stdout: str) -> Dict[str, Any]:
        try:
            return json.loads(stdout)
        except Exception:
            return {
                "ok": False,
                "outputs": [],
                "stdout": "",
                "stderr": "",
                "error": f"Large sandbox worker did not return JSON. Raw output: {stdout[-4000:]}",
            }

    def _update(self, job_id: str, **updates: Any) -> None:
        job_dir = self.jobs_root / job_id
        job_path = job_dir / "job.json"
        try:
            state = json.loads(job_path.read_text(encoding="utf-8"))
        except Exception:
            state = {"job_id": job_id}
        previous_progress = state.get("progress") if isinstance(state.get("progress"), dict) else {}
        state.update(updates)
        state["updated_at"] = self._now()
        if "progress" in updates and isinstance(updates["progress"], dict):
            state["progress"] = {**previous_progress, **updates["progress"]}
        self._write_json(job_path, state)

    def _finish(self, job_id: str, result: Dict[str, Any]) -> None:
        job_dir = self.jobs_root / job_id
        result_path = job_dir / "result.json"
        result["result_path"] = str(result_path)
        self._write_json(result_path, result)
        self._write_json(job_dir / "job.json", result)

    def _write_json(self, path: Path, payload: Dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")

    def _selection_payload(self, request: OperationJobCreateRequest) -> Dict[str, Any]:
        if hasattr(request.selection, "model_dump"):
            return request.selection.model_dump(exclude_none=True)
        return request.selection.dict(exclude_none=True)

    def _append_log(self, job_dir: Path, message: str) -> None:
        timestamp = self._now()
        with (job_dir / "logs.txt").open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {message}\n")

    def _duration_ms(self, started_at: datetime) -> float:
        return round((datetime.now(timezone.utc) - started_at).total_seconds() * 1000, 2)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _subprocess_env(self) -> Dict[str, str]:
        import os

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


class OperationCanceled(Exception):
    pass
