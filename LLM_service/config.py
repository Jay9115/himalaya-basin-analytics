import os
import sys
from pathlib import Path

from dotenv import load_dotenv


def get_service_root() -> Path:
    """Resolve service root for source mode and PyInstaller frozen mode."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


SERVICE_ROOT = get_service_root()
load_dotenv(SERVICE_ROOT / ".env")

# "embedded" runs llama-cpp-python in-process; "external" proxies to llama-server.
LLM_BACKEND = os.getenv("LLM_BACKEND", "embedded").strip().lower()
if LLM_BACKEND not in {"embedded", "external"}:
    raise ValueError(f"Invalid LLM_BACKEND={LLM_BACKEND!r}. Use 'embedded' or 'external'.")

MODEL_FILENAME = os.getenv("MODEL_FILENAME", "qwen2.5-coder-7b-instruct-q4_k_m.gguf")
_default_model_path = SERVICE_ROOT / "Models" / MODEL_FILENAME
MODEL_PATH = Path(os.getenv("MODEL_PATH", str(_default_model_path))).expanduser().resolve()

MODEL_NAME = os.getenv("MODEL_NAME", MODEL_PATH.stem)
LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080").rstrip("/")

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8010"))

DEFAULT_TEMPERATURE = float(os.getenv("DEFAULT_TEMPERATURE", "0.7"))
DEFAULT_MAX_TOKENS = int(os.getenv("DEFAULT_MAX_TOKENS", "2048"))

N_CTX = int(os.getenv("N_CTX", "8192"))
N_GPU_LAYERS = int(os.getenv("N_GPU_LAYERS", "-1"))
N_THREADS = int(os.getenv("N_THREADS", "0"))  # 0 = llama.cpp default (CPU core count)
VERBOSE_LLM = os.getenv("VERBOSE_LLM", "false").strip().lower() in {"1", "true", "yes"}
