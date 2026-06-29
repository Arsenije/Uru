"""A minimal OpenAI-compatible proxy that fans out to two llama.cpp servers.

khora (via LiteLLM) sends every call to a single ``OPENAI_API_BASE`` and never
sets a per-call ``api_base`` — so we expose one base URL here and route by
endpoint: chat/completions to the resident chat model, embeddings to the
resident embedding model. Both upstreams are single-model servers that never
evict, so there is no model-reload thrash.
"""

from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse

# llama.cpp can be slow on a cold model load + long extraction prompts.
_TIMEOUT = httpx.Timeout(600.0, connect=10.0)


def build_proxy_router(chat_base: str, embed_base: str) -> APIRouter:
    """Return a router exposing /v1/{chat/completions,completions,embeddings,models}."""
    router = APIRouter()

    async def _forward(target: str, body: bytes) -> Response:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                target, content=body, headers={"content-type": "application/json"}
            )
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )

    @router.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> Response:
        body = await request.body()
        streaming = False
        try:
            streaming = bool(json.loads(body).get("stream"))
        except (json.JSONDecodeError, ValueError):
            pass
        target = f"{chat_base}/v1/chat/completions"
        if not streaming:
            return await _forward(target, body)

        # Pass the upstream SSE through unbuffered so tokens arrive incrementally.
        async def upstream():
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                async with client.stream(
                    "POST", target, content=body,
                    headers={"content-type": "application/json"},
                ) as r:
                    async for chunk in r.aiter_raw():
                        yield chunk

        return StreamingResponse(upstream(), media_type="text/event-stream")

    @router.post("/v1/completions")
    async def completions(request: Request) -> Response:
        return await _forward(f"{chat_base}/v1/completions", await request.body())

    @router.post("/v1/embeddings")
    async def embeddings(request: Request) -> Response:
        raw = await request.body()
        # OpenAI's text-embedding-3 `dimensions` param isn't supported by
        # llama.cpp; khora always sends it, so drop it to avoid a 4xx.
        try:
            payload = json.loads(raw)
            payload.pop("dimensions", None)
            raw = json.dumps(payload).encode()
        except (json.JSONDecodeError, ValueError):
            pass
        return await _forward(f"{embed_base}/v1/embeddings", raw)

    @router.get("/v1/models")
    async def models() -> dict:
        return {
            "object": "list",
            "data": [
                {"id": "uru-chat", "object": "model", "owned_by": "uru"},
                {"id": "uru-embed", "object": "model", "owned_by": "uru"},
            ],
        }

    return router
