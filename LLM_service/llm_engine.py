from __future__ import annotations

import threading
from typing import Any

import config

_lock = threading.Lock()
_model = None
_model_error: str | None = None


def _resolve_thread_count() -> int | None:
    if config.N_THREADS <= 0:
        return None
    return config.N_THREADS


def get_model_status() -> dict[str, Any]:
    with _lock:
        if _model is not None:
            return {
                "backend": "embedded",
                "loaded": True,
                "model_path": str(config.MODEL_PATH),
                "model_name": config.MODEL_NAME,
            }
        if _model_error:
            return {
                "backend": "embedded",
                "loaded": False,
                "model_path": str(config.MODEL_PATH),
                "error": _model_error,
            }
        return {
            "backend": "embedded",
            "loaded": False,
            "model_path": str(config.MODEL_PATH),
        }


def ensure_model_loaded() -> None:
    global _model, _model_error

    with _lock:
        if _model is not None:
            return
        if _model_error is not None:
            raise RuntimeError(_model_error)

        if not config.MODEL_PATH.is_file():
            _model_error = f"Model file not found: {config.MODEL_PATH}"
            raise RuntimeError(_model_error)

        try:
            from llama_cpp import Llama
        except ImportError as exc:
            _model_error = (
                "llama-cpp-python is not installed. "
                "Run: pip install -r requirements.txt"
            )
            raise RuntimeError(_model_error) from exc

        llama_kwargs: dict[str, Any] = {
            "model_path": str(config.MODEL_PATH),
            "n_ctx": config.N_CTX,
            "n_gpu_layers": config.N_GPU_LAYERS,
            "verbose": config.VERBOSE_LLM,
        }
        thread_count = _resolve_thread_count()
        if thread_count is not None:
            llama_kwargs["n_threads"] = thread_count

        try:
            _model = Llama(**llama_kwargs)
        except Exception as exc:
            _model_error = f"Failed to load model: {exc}"
            raise RuntimeError(_model_error) from exc


def create_chat_completion(
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    ensure_model_loaded()

    with _lock:
        if _model is None:
            raise RuntimeError("Model is not loaded.")
        return _model.create_chat_completion(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
        )
