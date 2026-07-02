"""The Uru sidecar control API (FastAPI).

Bearer-auth on every route except /health (which the plugin polls for readiness).
The OpenAI proxy that fronts the llama servers runs on a *separate* internal port
(see lifecycle.py) and is never exposed here.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .lifecycle import SidecarRuntime
from .models import (
    BatchRequest,
    ChatRequest,
    ForgetRequest,
    LinkRequest,
    RecallRequest,
    RememberRequest,
)
from .serialize import batch_to_dict, recall_to_dict, remember_to_dict

log = logging.getLogger("uru.sidecar")


def build_app(runtime: SidecarRuntime) -> FastAPI:
    app = FastAPI(title="Uru sidecar")
    # Obsidian's renderer issues a CORS preflight for fetch() with a JSON body +
    # Authorization header (used by the streaming /index/full call). Allow it —
    # the Bearer token is the real gate and we only bind 127.0.0.1.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    token = runtime.config.token

    @app.middleware("http")
    async def _track_activity(request, call_next):
        runtime.touch()  # any request resets the idle watchdog
        # /health fires every ~15s from the plugin heartbeat; counting it would
        # pin inflight>0 forever and defeat genuine idle shutdown. Real work
        # (remember/recall/chat) is guarded so a long note can't be killed mid-flight.
        if request.url.path == "/health":
            return await call_next(request)
        runtime.begin_request()
        try:
            return await call_next(request)
        finally:
            runtime.touch()  # reset idle at request END too, so long calls don't leave it stale
            runtime.end_request()

    def require_auth(authorization: str = Header(default="")) -> None:
        if not token:  # no token configured -> open (dev only)
            return
        expected = f"Bearer {token}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/health")
    async def health() -> dict:
        return await runtime.health()

    @app.post("/recall", dependencies=[Depends(require_auth)])
    async def recall(req: RecallRequest) -> dict:
        result = await runtime.recall(
            req.query, limit=req.limit, min_similarity=req.min_similarity
        )
        return recall_to_dict(result)

    @app.post("/remember", dependencies=[Depends(require_auth)])
    async def remember(req: RememberRequest) -> dict:
        result = await runtime.remember(
            external_id=req.external_id, content=req.content,
            title=req.title, metadata=req.metadata,
        )
        return remember_to_dict(result)

    @app.post("/chat", dependencies=[Depends(require_auth)])
    async def chat(req: ChatRequest):
        history = [m.model_dump() for m in req.history]
        note = req.note.model_dump() if req.note else None
        if not req.stream:
            return await runtime.chat_once(req.query, history, req.limit, note)

        async def stream():
            async for ev in runtime.chat_stream(req.query, history, req.limit, note):
                yield json.dumps(ev) + "\n"

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/forget", dependencies=[Depends(require_auth)])
    async def forget(req: ForgetRequest) -> dict:
        return {
            "deleted": await runtime.forget(
                external_id=req.external_id, document_id=req.document_id
            )
        }

    @app.post("/index/full", dependencies=[Depends(require_auth)])
    async def index_full(req: BatchRequest) -> StreamingResponse:
        """Run remember_batch, streaming NDJSON progress events.

        khora's on_progress is a sync callback fired on this event loop; we
        bridge it to the response via a queue and run the batch as a task.
        """
        docs = [d.model_dump() for d in req.documents]
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def on_progress(completed: int, total: int) -> None:
            loop.call_soon_threadsafe(
                queue.put_nowait, {"event": "progress", "completed": completed, "total": total}
            )

        async def run() -> None:
            try:
                result = await runtime.remember_batch(docs, on_progress=on_progress)
                await queue.put({"event": "done", **batch_to_dict(result)})
            except Exception as exc:  # noqa: BLE001 — surface to the client
                log.exception("index/full failed")
                await queue.put({"event": "error", "message": str(exc)})
            finally:
                await queue.put(None)

        async def stream():
            task = asyncio.create_task(run())
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    yield json.dumps(item) + "\n"
            finally:
                if not task.done():
                    task.cancel()

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/graph/links", dependencies=[Depends(require_auth)])
    async def graph_links(req: LinkRequest) -> StreamingResponse:
        """Compute related-note links (semantic + lexical), streaming NDJSON.

        Emits {"event":"progress",...} while embedding, then a single
        {"event":"done","links":{...},"stats":{...}}. Read-only: computes
        suggestions from note text; the plugin writes them as frontmatter.
        """
        docs = [{"external_id": d.external_id, "content": d.content} for d in req.documents]
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def on_progress(completed: int, total: int) -> None:
            loop.call_soon_threadsafe(
                queue.put_nowait, {"event": "progress", "completed": completed, "total": total}
            )

        async def run() -> None:
            try:
                result = await runtime.compute_links(
                    docs, k=req.k, min_cos=req.min_cos, min_bm25=req.min_bm25,
                    on_progress=on_progress,
                )
                await queue.put({"event": "done", **result})
            except Exception as exc:  # noqa: BLE001 — surface to the client
                log.exception("graph/links failed")
                await queue.put({"event": "error", "message": str(exc)})
            finally:
                await queue.put(None)

        async def stream():
            task = asyncio.create_task(run())
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    yield json.dumps(item) + "\n"
            finally:
                if not task.done():
                    task.cancel()

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/shutdown", dependencies=[Depends(require_auth)])
    async def shutdown() -> dict:
        # Tear down khora/llama, then ask uvicorn to exit.
        await runtime.stop()
        import os
        import signal

        os.kill(os.getpid(), signal.SIGTERM)
        return {"ok": True}

    return app
