"""A minimal OpenAI-compatible proxy that fans out to two llama.cpp servers.

khora (via LiteLLM) sends every call to a single ``OPENAI_API_BASE`` and never
sets a per-call ``api_base`` — so we expose one base URL here and route by
endpoint: chat/completions to the resident chat model, embeddings to the
resident embedding model. Both upstreams are single-model servers that never
evict, so there is no model-reload thrash.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

# llama.cpp can be slow on a cold model load + long prompts.
_TIMEOUT = httpx.Timeout(600.0, connect=10.0)

# finish_reason values meaning "hit the output-token ceiling" rather than a
# natural stop — the clearest signal a generation didn't converge on its own
# (matches khora's own _TRUNCATION_FINISH_REASONS check).
_CAP_FINISH_REASONS = frozenset({"length", "max_tokens"})


@dataclass
class ChatCallStat:
    duration_s: float
    prompt_tokens: int | None
    completion_tokens: int | None
    finish_reason: str | None
    # First ~200 chars of the last user message — enough to spot which note/chunk
    # a slow or capped call came from without needing to correlate timestamps
    # against a separate log.
    prompt_preview: str | None = None

    @property
    def hit_cap(self) -> bool:
        return (self.finish_reason or "").lower() in _CAP_FINISH_REASONS


def _last_user_message_preview(body: bytes, limit: int = 200) -> str | None:
    try:
        messages = json.loads(body).get("messages") or []
        for msg in reversed(messages):
            if msg.get("role") == "user" and msg.get("content"):
                content = str(msg["content"])
                return content[:limit] + ("…" if len(content) > limit else "")
    except (json.JSONDecodeError, ValueError, AttributeError, TypeError):
        pass
    return None


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    try:
        with path.open("a") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except OSError:
        pass  # best-effort debug aid; never let logging break a real request


def build_proxy_router(
    chat_base: Callable[[], str],
    embed_base: Callable[[], str],
    on_chat_completion: Callable[[ChatCallStat], None] | None = None,
    raw_log_path: Path | None = None,
    openai_chat: dict[str, str] | None = None,
    api_key: str = "",
) -> APIRouter:
    """Return a router exposing /v1/{chat/completions,completions,embeddings,models}.

    ``chat_base``/``embed_base`` are *getters*, resolved per request — a llama
    server that crash-restarts may come back on a new port, and frozen strings
    would keep routing to the dead one.

    ``api_key`` (the sidecar token) gates every route (401 without the matching
    Bearer header) and is forwarded upstream to the --api-key-protected llama
    servers. Empty means open — dev only, mirroring app.py.

    ``raw_log_path``, if given, gets one JSON line per chat-completion call with
    the full request + response bodies — for offline debugging of chat
    behavior (what prompt went in, what came back, verbatim). Kept separate
    from ``ChatCallStat``/``on_chat_completion``, which stay small and cheap
    for the always-on /health rolling window; this is opt-in and unbounded.

    ``openai_chat`` (TEMPORARY testing aid), if given as
    ``{"base": "https://api.openai.com/v1", "key": "sk-...", "model": "gpt-4o-mini"}``,
    routes chat/completions to real OpenAI instead of the local
    chat server — the note model is rewritten to ``model``. Embeddings stay local
    (bge-m3), so the vector dimension is unchanged. Lets us test against a cloud
    model without touching khora's single-base config.
    """
    router = APIRouter()

    def _require_key(authorization: str = Header(default="")) -> None:
        if not api_key:  # no key configured -> open (dev only)
            return
        if authorization != f"Bearer {api_key}":
            raise HTTPException(status_code=401, detail="unauthorized")

    def _local_headers() -> dict[str, str]:
        """Headers for the api-key-protected local llama servers."""
        headers = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        return headers

    async def _forward(target: str, body: bytes, headers: dict[str, str] | None = None) -> Response:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                target, content=body, headers=headers or _local_headers()
            )
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )

    def _chat_target() -> tuple[str, dict[str, str]]:
        """Where chat/completions goes + headers: local server, or real OpenAI."""
        if openai_chat:
            return (f"{openai_chat['base']}/chat/completions",
                    {"content-type": "application/json",
                     "authorization": f"Bearer {openai_chat['key']}"})
        return f"{chat_base()}/v1/chat/completions", _local_headers()

    def _rewrite_model(body: bytes) -> bytes:
        """When routing to OpenAI, replace the note model name with the real one."""
        if not openai_chat:
            return body
        try:
            payload = json.loads(body)
            payload["model"] = openai_chat["model"]
            return json.dumps(payload).encode()
        except (json.JSONDecodeError, ValueError):
            return body

    def _report_non_streaming(t0: float, req_body: bytes, raw: bytes) -> None:
        duration = time.perf_counter() - t0
        try:
            data = json.loads(raw)
            usage = data.get("usage") or {}
            finish_reason = (data.get("choices") or [{}])[0].get("finish_reason")
        except (json.JSONDecodeError, ValueError, IndexError, AttributeError):
            data, usage, finish_reason = None, {}, None
        if raw_log_path is not None:
            try:
                request_json: Any = json.loads(req_body)
            except (json.JSONDecodeError, ValueError):
                request_json = None
            _append_jsonl(raw_log_path, {
                "duration_s": round(duration, 2),
                "streaming": False,
                "request": request_json,
                "response": data,
            })
        if on_chat_completion is not None:
            on_chat_completion(ChatCallStat(
                duration_s=duration,
                prompt_tokens=usage.get("prompt_tokens"),
                completion_tokens=usage.get("completion_tokens"),
                finish_reason=finish_reason,
                prompt_preview=_last_user_message_preview(req_body),
            ))

    @router.post("/v1/chat/completions", dependencies=[Depends(_require_key)])
    async def chat_completions(request: Request) -> Response:
        body = await request.body()
        streaming = False
        try:
            streaming = bool(json.loads(body).get("stream"))
        except (json.JSONDecodeError, ValueError):
            pass
        target, headers = _chat_target()
        body = _rewrite_model(body)  # no-op unless routing to OpenAI
        t0 = time.perf_counter()
        if not streaming:
            resp = await _forward(target, body, headers)
            _report_non_streaming(t0, body, resp.body)
            return resp

        # Pass the upstream SSE through unbuffered so tokens arrive incrementally,
        # while still watching for the final chunk's finish_reason so streaming
        # every chat call gets the same loop/duration visibility.
        async def upstream():
            finish_reason: str | None = None
            content_parts: list[str] = []
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                    async with client.stream(
                        "POST", target, content=body, headers=headers,
                    ) as r:
                        buf = b""
                        async for chunk in r.aiter_raw():
                            yield chunk
                            buf += chunk
                            while b"\n" in buf:
                                line, buf = buf.split(b"\n", 1)
                                line = line.strip()
                                if not line.startswith(b"data: ") or line.endswith(b"[DONE]"):
                                    continue
                                try:
                                    ev = json.loads(line[len(b"data: "):])
                                    choice = (ev.get("choices") or [{}])[0]
                                    fr = choice.get("finish_reason")
                                    if fr:
                                        finish_reason = fr
                                    delta = (choice.get("delta") or {}).get("content")
                                    if delta:
                                        content_parts.append(delta)
                                except (json.JSONDecodeError, ValueError, IndexError, AttributeError):
                                    pass
            finally:
                duration = time.perf_counter() - t0
                if raw_log_path is not None:
                    try:
                        request_json: Any = json.loads(body)
                    except (json.JSONDecodeError, ValueError):
                        request_json = None
                    _append_jsonl(raw_log_path, {
                        "duration_s": round(duration, 2),
                        "streaming": True,
                        "request": request_json,
                        "response": {"content": "".join(content_parts), "finish_reason": finish_reason},
                    })
                if on_chat_completion is not None:
                    on_chat_completion(ChatCallStat(
                        duration_s=duration,
                        prompt_tokens=None,
                        completion_tokens=None,
                        finish_reason=finish_reason,
                        prompt_preview=_last_user_message_preview(body),
                    ))

        return StreamingResponse(upstream(), media_type="text/event-stream")

    @router.post("/v1/completions", dependencies=[Depends(_require_key)])
    async def completions(request: Request) -> Response:
        return await _forward(f"{chat_base()}/v1/completions", await request.body())

    @router.post("/v1/embeddings", dependencies=[Depends(_require_key)])
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
        return await _forward(f"{embed_base()}/v1/embeddings", raw)

    @router.get("/v1/models", dependencies=[Depends(_require_key)])
    async def models() -> dict:
        return {
            "object": "list",
            "data": [
                {"id": "uru-chat", "object": "model", "owned_by": "uru"},
                {"id": "uru-embed", "object": "model", "owned_by": "uru"},
            ],
        }

    return router
