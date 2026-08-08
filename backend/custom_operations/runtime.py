"""Resolve sandbox worker commands for source and PyInstaller frozen runs."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List

SANDBOX_WORKER_DIR = "sandbox_worker"
LARGE_WORKER_DIR = "large_worker"


def is_frozen_runtime() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_app_runtime_dir() -> Path:
    if is_frozen_runtime():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def resolve_worker_command(worker: str) -> List[str]:
    if worker == "sandbox":
        frozen_dir = SANDBOX_WORKER_DIR
        script_name = "worker.py"
    elif worker == "large":
        frozen_dir = LARGE_WORKER_DIR
        script_name = "large_worker.py"
    else:
        raise ValueError(f"Unknown worker: {worker}")

    if is_frozen_runtime():
        worker_exe = get_app_runtime_dir() / frozen_dir / f"{frozen_dir}.exe"
        if not worker_exe.exists():
            raise FileNotFoundError(f"Worker executable not found: {worker_exe}")
        return [str(worker_exe)]

    script_path = Path(__file__).with_name(script_name)
    return [sys.executable, "-I", str(script_path)]
