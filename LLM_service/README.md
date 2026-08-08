# Himalaya Basin Analytics LLM Service

FastAPI wrapper for the bundled Qwen 2.5 Coder model. Runs on **port 8010** by default so it does not conflict with the main webapp backend on port 8000.

## Quick start

### Windows

```powershell
cd LLM_service
.\run.ps1
```

### Linux / macOS

```bash
cd LLM_service
chmod +x run.sh
./run.sh
```

### Manual start

```bash
cd LLM_service
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Service URL: `http://127.0.0.1:8010`

## Project structure

- `main.py` — FastAPI server
- `config.py` — environment-driven configuration
- `llm_engine.py` — embedded llama-cpp-python inference
- `prompts.py` — prompt builders for chat/code/explain
- `Models/` — bundled GGUF model file
- `run.ps1` / `run.sh` — cross-platform launchers with venv bootstrap

## Backends

| Mode | Description |
|------|-------------|
| `embedded` (default) | Loads the GGUF model in-process via `llama-cpp-python`. No separate llama-server required. |
| `external` | Proxies to an OpenAI-compatible server (e.g. llama-server) at `LLAMA_SERVER_URL`. |

Set `LLM_BACKEND=external` in `.env` to use an external server.

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

Key settings:

- `MODEL_PATH` — absolute or relative path to the `.gguf` file (defaults to `Models/qwen2.5-coder-7b-instruct-q4_k_m.gguf`)
- `N_GPU_LAYERS=-1` — use GPU when available; set `0` for CPU-only machines
- `N_THREADS=0` — auto-detect CPU threads
- `PORT=8010` — API port

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service and model status |
| GET | `/models` | Available models |
| POST | `/chat` | General chat with system prompt |
| POST | `/generate` | Code or explain generation |

### Example

```bash
curl http://127.0.0.1:8010/health

curl -X POST http://127.0.0.1:8010/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What objects are available in HB analytics?"}'
```

## System requirements

- Python 3.10+
- ~5 GB disk space for the model
- 8+ GB RAM recommended for CPU inference
- Optional: CUDA/Metal-capable GPU for faster inference (`N_GPU_LAYERS=-1`)

## Troubleshooting

**Model not found** — ensure `Models/qwen2.5-coder-7b-instruct-q4_k_m.gguf` exists or set `MODEL_PATH` in `.env`.

**llama-cpp-python install fails** — the service uses prebuilt CPU wheels via an extra index URL in `requirements.txt`. Upgrade pip and retry:

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

For NVIDIA GPU acceleration, install from the CUDA wheel index instead:

```bash
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121
```

**Out of memory** — set `N_GPU_LAYERS=0`, reduce `N_CTX`, or use a smaller quantised model.

**Port in use** — change `PORT` in `.env`.
