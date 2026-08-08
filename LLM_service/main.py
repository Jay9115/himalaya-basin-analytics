from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi.middleware.cors import CORSMiddleware
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import config
import llm_engine
import prompts


@asynccontextmanager
async def lifespan(_: FastAPI):
    if config.LLM_BACKEND == "embedded":
        try:
            llm_engine.ensure_model_loaded()
        except RuntimeError as exc:
            # Keep the API up so /health can report the load failure.
            print(f"[LLM] Warning: {exc}")
    yield


app = FastAPI(
    title="Himalaya Basin Analytics LLM Service",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    temperature: Optional[float] = config.DEFAULT_TEMPERATURE
    max_tokens: Optional[int] = config.DEFAULT_MAX_TOKENS


class GenerateRequest(BaseModel):
    prompt_type: str  # 'code' or 'explain'
    content: str
    temperature: Optional[float] = config.DEFAULT_TEMPERATURE
    max_tokens: Optional[int] = config.DEFAULT_MAX_TOKENS


@app.get("/health")
def health_check():
    status = {
        "status": "ok",
        "backend": config.LLM_BACKEND,
        "host": config.HOST,
        "port": config.PORT,
    }
    if config.LLM_BACKEND == "embedded":
        status.update(llm_engine.get_model_status())
    else:
        status["llama_server_url"] = config.LLAMA_SERVER_URL
    return status


@app.get("/models")
def get_models():
    if config.LLM_BACKEND == "embedded":
        llm_engine.ensure_model_loaded()
        return {
            "object": "list",
            "data": [{"id": config.MODEL_NAME, "object": "model"}],
        }

    try:
        response = requests.get(f"{config.LLAMA_SERVER_URL}/v1/models", timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/chat")
def chat(req: ChatRequest):
    messages = prompts.build_chat_prompt(req.message)
    return run_completion(messages, req.temperature, req.max_tokens)


@app.post("/generate")
def generate(req: GenerateRequest):
    if req.prompt_type == "code":
        messages = prompts.build_code_prompt(req.content)
    elif req.prompt_type == "explain":
        messages = prompts.build_explain_prompt(req.content)
    else:
        raise HTTPException(
            status_code=400,
            detail="prompt_type must be 'code' or 'explain'",
        )
    return run_completion(messages, req.temperature, req.max_tokens)


def run_completion(messages: List[dict], temp: float, tokens: int):
    if config.LLM_BACKEND == "embedded":
        try:
            return llm_engine.create_chat_completion(messages, temp, tokens)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    payload = {
        "model": config.MODEL_NAME,
        "messages": messages,
        "temperature": temp,
        "max_tokens": tokens,
        "stream": False,
    }
    try:
        resp = requests.post(
            f"{config.LLAMA_SERVER_URL}/v1/chat/completions",
            json=payload,
            timeout=300,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=config.HOST,
        port=config.PORT,
        reload=False,
    )
