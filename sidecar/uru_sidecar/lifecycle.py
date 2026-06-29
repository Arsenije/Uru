"""SidecarRuntime: owns the llama.cpp servers, the OpenAI proxy, and Khora.

Startup order matters: the two inference servers and the proxy must be up and the
KHORA_*/OPENAI_* env exported *before* Khora() is constructed, because khora reads
its config at construction time.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable

from .config import SidecarConfig
from .llama import LlamaServer, free_port

log = logging.getLogger("uru.sidecar")


class SidecarRuntime:
    def __init__(self, config: SidecarConfig) -> None:
        self.config = config
        self.status = "starting"
        self.error: str | None = None
        self.namespace_id: str | None = None
        self.last_activity = time.monotonic()
        self._kb: Any = None
        self._chat: LlamaServer | None = None
        self._embed: LlamaServer | None = None
        self._proxy_server: Any = None
        self._proxy_task: asyncio.Task | None = None

    # ---- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        cfg = self.config
        work = cfg.work_dir
        self._chat = LlamaServer(
            cfg.chat_model_path, work, alias="uru-chat",
            n_ctx=cfg.n_ctx_chat, n_gpu_layers=cfg.n_gpu_layers,
        )
        self._embed = LlamaServer(
            cfg.embed_model_path, work, alias="uru-embed", embedding=True,
            n_ctx=cfg.n_ctx_embed, n_gpu_layers=cfg.n_gpu_layers,
        )
        log.info("starting llama.cpp servers (chat + embed)")
        self._chat.start()
        self._embed.start()
        await asyncio.gather(
            asyncio.to_thread(self._chat.wait_ready),
            asyncio.to_thread(self._embed.wait_ready),
        )

        proxy_base = await self._start_proxy(self._chat.base_url, self._embed.base_url)
        os.environ.update(cfg.khora_env(proxy_base))
        log.info("proxy up at %s; connecting khora", proxy_base)

        from khora import Khora  # imported after env is set

        self._kb = Khora(run_migrations=True)
        await self._kb.connect()
        await self._bootstrap_namespace()
        self.status = "ok"
        log.info("sidecar ready (namespace=%s)", self.namespace_id)

    async def _start_proxy(self, chat_base: str, embed_base: str) -> str:
        import uvicorn
        from fastapi import FastAPI

        from .proxy import build_proxy_router

        port = free_port()
        app = FastAPI()
        app.include_router(build_proxy_router(chat_base, embed_base))
        self._proxy_server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        )
        self._proxy_task = asyncio.create_task(self._proxy_server.serve())
        while not self._proxy_server.started:
            await asyncio.sleep(0.05)
        return f"http://127.0.0.1:{port}/v1"

    async def _bootstrap_namespace(self) -> None:
        cfg = self.config
        if cfg.namespace_id:
            ns = await self._kb.get_namespace_by_stable_id(cfg.namespace_id)
            if ns is not None:
                self.namespace_id = str(ns.namespace_id)
                return
            log.warning("namespace %s not found in DB; creating a fresh one", cfg.namespace_id)
        ns = await self._kb.create_namespace(metadata={"app": "uru"})
        self.namespace_id = str(ns.namespace_id)

    async def stop(self) -> None:
        self.status = "stopping"
        if self._kb is not None:
            try:
                await self._kb.disconnect()
            except Exception:  # noqa: BLE001 — shutdown best-effort
                log.exception("error disconnecting khora")
        if self._proxy_server is not None:
            self._proxy_server.should_exit = True
        if self._proxy_task is not None:
            try:
                await self._proxy_task
            except Exception:  # noqa: BLE001
                pass
        if self._chat:
            self._chat.stop()
        if self._embed:
            self._embed.stop()

    def touch(self) -> None:
        """Record activity; resets the idle-shutdown watchdog."""
        self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity

    # ---- operations ------------------------------------------------------

    async def health(self) -> dict[str, Any]:
        kb_health = await self._kb.health_check() if self._kb else {"status": "disconnected"}
        return {
            "status": self.status,
            "error": self.error,
            "namespace_id": self.namespace_id,
            "backend": "sqlite_lance",
            "extract_entities": self.config.extract_entities,
            "models": {"chat": "uru-chat", "embed": "uru-embed"},
            "khora": kb_health,
        }

    async def recall(self, query: str, *, limit: int = 10, min_similarity: float = 0.0) -> Any:
        return await self._kb.recall(
            query, namespace=self.namespace_id, limit=limit, min_similarity=min_similarity
        )

    async def remember(self, *, external_id: str, content: str, title: str = "",
                       metadata: dict | None = None) -> Any:
        cfg = self.config
        return await self._kb.remember(
            content,
            namespace=self.namespace_id,
            title=title,
            external_id=external_id,
            metadata=metadata or {},
            entity_types=cfg.entity_types,
            relationship_types=cfg.relationship_types,
        )

    async def remember_batch(self, documents: list[dict], *,
                             on_progress: Callable[[int, int], None] | None = None) -> Any:
        cfg = self.config
        return await self._kb.remember_batch(
            documents,
            namespace=self.namespace_id,
            entity_types=cfg.entity_types,
            relationship_types=cfg.relationship_types,
            on_progress=on_progress,
        )

    # ---- chat (RAG) ------------------------------------------------------

    _CHAT_SYSTEM = (
        "You are a helpful assistant answering questions about the user's personal "
        "Obsidian vault. Use ONLY the provided context notes to answer. Cite the "
        "notes you draw on by their bracketed number, e.g. [1]. If the context does "
        "not contain the answer, say you couldn't find it in the vault."
    )

    async def _chat_context(self, query: str, limit: int):
        res = await self.recall(query, limit=limit)
        docs = {d.id: d for d in res.documents}
        blocks: list[str] = []
        citations: list[dict] = []
        seen: set[str] = set()
        for i, c in enumerate(res.chunks[:limit], 1):
            doc = docs.get(c.document_id)
            title = (getattr(doc, "title", None) or getattr(doc, "external_id", None) or "source")
            blocks.append(f"[{i}] {title}\n{c.content.strip()}")
            ext = getattr(doc, "external_id", None)
            if ext and ext not in seen:
                seen.add(ext)
                citations.append({"index": i, "external_id": ext, "title": title})
        return "\n\n".join(blocks) if blocks else "(no matching notes)", citations

    def _chat_messages(self, query: str, context: str, history: list[dict] | None):
        msgs = [{"role": "system", "content": self._CHAT_SYSTEM}]
        for h in (history or [])[-6:]:
            msgs.append({"role": h["role"], "content": h["content"]})
        msgs.append({"role": "user", "content": f"Context notes:\n\n{context}\n\n---\nQuestion: {query}"})
        return msgs

    async def chat_once(self, query: str, history=None, limit: int = 8) -> dict:
        import litellm

        context, citations = await self._chat_context(query, limit)
        resp = await litellm.acompletion(
            model="openai/uru-chat",
            messages=self._chat_messages(query, context, history),
            timeout=self.config.llm_timeout,
        )
        answer = (resp.choices[0].message.content or "") if resp.choices else ""
        return {"answer": answer, "citations": citations}

    async def chat_stream(self, query: str, history=None, limit: int = 8):
        import litellm

        context, citations = await self._chat_context(query, limit)
        yield {"event": "sources", "citations": citations}
        stream = await litellm.acompletion(
            model="openai/uru-chat",
            messages=self._chat_messages(query, context, history),
            timeout=self.config.llm_timeout,
            stream=True,
        )
        async for part in stream:
            delta = part.choices[0].delta.content if part.choices else None
            if delta:
                yield {"event": "token", "text": delta}
        yield {"event": "done"}

    async def forget(self, *, external_id: str | None = None,
                     document_id: str | None = None) -> bool:
        from uuid import UUID

        # Fast path: the indexer already knows the document id.
        if document_id:
            return await self._kb.forget(UUID(document_id), namespace=self.namespace_id)
        if not external_id:
            return False
        # Resolve external_id -> document. Low-level storage is keyed by the
        # *resolved row* namespace id (ns.id), not the stable namespace_id that
        # the public API takes — so resolve the namespace first.
        ns = await self._kb.get_namespace_by_stable_id(self.namespace_id)
        storage = getattr(self._kb._engine, "_storage", None)
        if ns is None or storage is None:
            return False
        doc = await storage.get_document_by_external_id(external_id, namespace_id=ns.id)
        if doc is None:
            return False
        return await self._kb.forget(doc.id, namespace=self.namespace_id)
