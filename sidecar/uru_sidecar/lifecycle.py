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
from collections import deque
from typing import Any, Callable

from .config import SidecarConfig
from .llama import LlamaServer, free_port
from .proxy import ChatCallStat

log = logging.getLogger("uru.sidecar")

# Chat calls (extraction or RAG-chat) slower than this are logged even if they
# eventually finished cleanly — a normal single-chunk extraction is seconds,
# not minutes.
_SLOW_CALL_THRESHOLD_S = 60.0


class SidecarRuntime:
    def __init__(self, config: SidecarConfig) -> None:
        self.config = config
        self.status = "starting"
        self.error: str | None = None
        self.namespace_id: str | None = None
        self.last_activity = time.monotonic()
        self._inflight = 0
        self._kb: Any = None
        self._chat: LlamaServer | None = None
        self._embed: LlamaServer | None = None
        self._proxy_server: Any = None
        self._proxy_task: asyncio.Task | None = None
        # Rolling window of recent chat-completion calls (extraction + RAG chat),
        # so /health can answer "how long is this taking, and is it looping"
        # without anyone having to grep llama-server's raw log by hand.
        self._llm_calls: deque[ChatCallStat] = deque(maxlen=50)
        # khora ExpertiseConfig (the extraction ontology) — built in start()
        # once khora is importable. See uru_sidecar/ontology.py.
        self._expertise: Any = None

    # ---- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        cfg = self.config
        work = cfg.work_dir
        self._chat = LlamaServer(
            cfg.llama_server_bin, cfg.chat_model_path, work, alias="uru-chat",
            n_ctx=cfg.n_ctx_chat, n_gpu_layers=cfg.n_gpu_layers,
        )
        self._embed = LlamaServer(
            cfg.llama_server_bin, cfg.embed_model_path, work, alias="uru-embed",
            embedding=True, n_ctx=cfg.n_ctx_embed, n_gpu_layers=cfg.n_gpu_layers,
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

        # Force grammar-constrained JSON (json_schema) for our local chat model.
        # llama-server enforces the schema via GBNF, so the small 3B reliably
        # emits the exact entity shape (`name` field). Without this, khora falls
        # back to loose json_object and the model picks inconsistent keys →
        # entities get dropped ("skipped N entities with empty/missing name").
        try:
            from khora.extraction.extractors.llm import LLMEntityExtractor

            LLMEntityExtractor.MODELS_REQUIRING_JSON_SCHEMA.add("openai/uru-chat")
        except Exception:  # noqa: BLE001 — best-effort; extraction still works (looser)
            log.warning("could not enable json_schema extraction mode")

        # Build our extraction ontology (ExpertiseConfig) and drive khora with it.
        # The primary/main extraction path reads expertise.system_prompt +
        # expertise.extraction_prompt directly. But khora's SECOND-PASS relationship
        # extraction hardcodes its module-level DEFAULT_SYSTEM_PROMPT instead of
        # reading expertise — so we also monkeypatch that global to the same shared
        # prompt, giving both paths the 3B-tuned guidance (concise, capped output,
        # no "extract even indirectly / N-to-2N relationships" that sends a small
        # model into a schema-unbounded, multi-minute runaway). khora reads the
        # global at call time (not as a bound default), so the patch takes effect.
        from . import ontology

        try:
            self._expertise = ontology.build_expertise()
        except Exception:  # noqa: BLE001 — fall back to plain type lists if khora API shifts
            log.warning("could not build ExpertiseConfig; using plain entity/relationship type lists")
        try:
            import khora.extraction.extractors.llm as _llm

            _llm.DEFAULT_SYSTEM_PROMPT = ontology.SYSTEM_PROMPT
        except Exception:  # noqa: BLE001 — best-effort; extraction still works (looser)
            log.warning("could not patch extraction system prompt for the local 3B model")

        # KET-RAG, part 1 — pin selective_extraction to our config value. The env
        # var KHORA_PIPELINES_SELECTIVE_EXTRACTION does NOT reach the VectorCypher
        # engine: it calls extract_entities() without passing the flag, so the
        # function's own default always wins on this path. The engine re-imports
        # extract_entities lazily inside each method, so replacing the module
        # attribute with a wrapper that pins the kwarg takes effect on every call.
        try:
            import khora.pipelines.tasks.extract as _extract_mod

            _orig_extract_entities = _extract_mod.extract_entities
            _selective = self.config.selective_extraction

            async def _extract_entities_pinned(*args, **kwargs):  # noqa: ANN
                kwargs["selective_extraction"] = _selective
                return await _orig_extract_entities(*args, **kwargs)

            _extract_mod.extract_entities = _extract_entities_pinned
        except Exception:  # noqa: BLE001 — best-effort; falls back to khora's default (selective on)
            log.warning("could not pin selective_extraction; khora default (on) will apply")

        # KET-RAG, part 2 — sever the uncapped rule-based co-occurrence edges that
        # skipped (non-LLM) chunks would otherwise get. extract_lightweight_edges()
        # does combinations() over every capitalized phrase in a chunk (quadratic,
        # ~990 edges from one note) and is imported lazily where it's used, so
        # replacing the module attribute with a no-op stops it while leaving
        # selective extraction (part 1) fully intact. Skipped chunks stay
        # vector-searchable; they just add no graph edges/entities.
        if not self.config.lightweight_cooccurrence_edges:
            try:
                import khora.extraction.importance as _importance_mod

                _importance_mod.extract_lightweight_edges = lambda _chunk: []
            except Exception:  # noqa: BLE001 — best-effort; hairball returns but nothing breaks
                log.warning("could not disable lightweight co-occurrence edges")

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
        app.include_router(build_proxy_router(
            chat_base, embed_base,
            on_chat_completion=self._record_llm_call,
            raw_log_path=self.config.debug_log_path,
        ))
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
        ns = await self._kb.create_namespace()
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

    def begin_request(self) -> None:
        """Mark a request in flight so the idle watchdog won't shut down mid-work
        (e.g. a Deep-mode note whose extraction runs longer than idle_timeout)."""
        self._inflight += 1

    def end_request(self) -> None:
        self._inflight = max(0, self._inflight - 1)

    def has_inflight(self) -> bool:
        return self._inflight > 0

    def _record_llm_call(self, stat: ChatCallStat) -> None:
        """Callback from the proxy: log + retain every chat-completion call's
        timing and outcome, so /health can report on duration and looping
        without anyone grepping llama-server's raw log by hand."""
        self._llm_calls.append(stat)
        if stat.hit_cap:
            log.warning(
                "LLM call ran %.1fs and hit the output-token cap (finish_reason=%s, "
                "completion_tokens=%s) — likely a runaway/looping generation rather "
                "than a natural stop. Input started: %r",
                stat.duration_s, stat.finish_reason, stat.completion_tokens, stat.prompt_preview,
            )
        elif stat.duration_s > _SLOW_CALL_THRESHOLD_S:
            log.warning(
                "LLM call ran %.1fs (completion_tokens=%s, finish_reason=%s) — "
                "unusually slow for a single chunk. Input started: %r",
                stat.duration_s, stat.completion_tokens, stat.finish_reason, stat.prompt_preview,
            )

    def llm_stats(self) -> dict[str, Any]:
        calls = list(self._llm_calls)
        if not calls:
            return {"calls": 0}
        durations = [c.duration_s for c in calls]
        loops = [c for c in calls if c.hit_cap]
        return {
            "calls": len(calls),
            "last_duration_s": round(durations[-1], 1),
            "avg_duration_s": round(sum(durations) / len(durations), 1),
            "max_duration_s": round(max(durations), 1),
            "possible_loops": len(loops),
            # Preview of what each looping call was extracting from, so a chunk
            # that hits the cap can be traced back without grepping raw logs.
            "loop_previews": [c.prompt_preview for c in loops[-5:]],
        }

    # ---- operations ------------------------------------------------------

    async def health(self) -> dict[str, Any]:
        kb_health = await self._kb.health_check() if self._kb else {"status": "disconnected"}
        chat_alive = self._chat.is_alive() if self._chat else False
        embed_alive = self._embed.is_alive() if self._embed else False
        status = self.status
        error = self.error
        # Don't report "ok" while an inference child is down — otherwise the
        # plugin shows a healthy badge while chat/recall/indexing silently fail.
        if status == "ok" and not (chat_alive and embed_alive):
            down = [n for n, a in (("chat", chat_alive), ("embed", embed_alive)) if not a]
            status = "error"
            error = error or f"inference server(s) down: {', '.join(down)}"
        return {
            "status": status,
            "error": error,
            "namespace_id": self.namespace_id,
            "backend": "sqlite_lance",
            "extract_entities": self.config.extract_entities,
            "models": {"chat": "uru-chat", "embed": "uru-embed"},
            "inference": {"chat": chat_alive, "embed": embed_alive},
            "khora": kb_health,
            "llm_stats": self.llm_stats(),
        }

    async def run_supervisor(self, interval: float = 5.0) -> None:
        """Restart any llama child that dies after startup.

        ``wait_ready`` / process polling only run at boot; without this loop a
        crashed chat or embed server stays dead while ``/health`` (now liveness
        aware) reports the outage. We restart in place (same port, proxy URL
        unchanged) and latch to ``error`` only if a restart itself fails.
        """
        while True:
            await asyncio.sleep(interval)
            if self.status != "ok":
                continue
            for server in (self._chat, self._embed):
                if server is None or server.is_alive():
                    continue
                log.error("llama-server '%s' exited; restarting", server.alias)
                try:
                    await asyncio.to_thread(server.restart)
                    log.info("llama-server '%s' back up", server.alias)
                except Exception as exc:  # noqa: BLE001 — surface via /health, keep serving
                    log.exception("restart of llama-server '%s' failed", server.alias)
                    self.status = "error"
                    self.error = f"{server.alias} crashed and could not be restarted: {exc}"

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
            expertise=self._expertise,
        )

    async def remember_batch(self, documents: list[dict], *,
                             on_progress: Callable[[int, int], None] | None = None) -> Any:
        cfg = self.config
        return await self._kb.remember_batch(
            documents,
            namespace=self.namespace_id,
            entity_types=cfg.entity_types,
            relationship_types=cfg.relationship_types,
            expertise=self._expertise,
            on_progress=on_progress,
        )

    async def compute_links(
        self, documents: list[dict], *,
        k: int | None = None, min_cos: float | None = None, min_bm25: float | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> dict:
        """Suggest related-note links (semantic + lexical) for the corpus.

        Runs the LLM-free linker against the local embed server. Purely additive:
        it reads note text only, never touches khora's graph or the vault — the
        plugin decides whether/how to write the returned links as frontmatter.
        """
        from . import linking

        if self._embed is None:
            raise RuntimeError("embed server not started")
        embed_base = self._embed.base_url
        kwargs: dict[str, Any] = {"on_progress": on_progress}
        if k is not None:
            kwargs["k"] = k
        if min_cos is not None:
            kwargs["min_cos"] = min_cos
        if min_bm25 is not None:
            kwargs["min_bm25"] = min_bm25
        return await asyncio.to_thread(linking.compute_links, documents, embed_base, **kwargs)

    # ---- chat (RAG) ------------------------------------------------------

    _CHAT_SYSTEM = (
        "You are a helpful assistant answering questions about the user's personal "
        "Obsidian vault. Use ONLY the provided context notes to answer. Cite the "
        "notes you draw on by their bracketed number, e.g. [1]. If the context does "
        "not contain the answer, say you couldn't find it in the vault."
    )

    async def _chat_context(self, query: str, limit: int, note: dict | None = None):
        # 'Current note' scope: use the note text directly, no vault recall.
        if note:
            content = (note.get("content") or "")[:16000]  # keep within chat n_ctx
            label = note.get("title") or note.get("external_id") or "current note"
            citation = {"index": 1, "external_id": note.get("external_id"), "title": label}
            return f"[1] {label}\n{content}", [citation]
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

    async def chat_once(self, query: str, history=None, limit: int = 8, note: dict | None = None) -> dict:
        import litellm

        context, citations = await self._chat_context(query, limit, note)
        resp = await litellm.acompletion(
            model="openai/uru-chat",
            messages=self._chat_messages(query, context, history),
            timeout=self.config.llm_timeout,
        )
        answer = (resp.choices[0].message.content or "") if resp.choices else ""
        return {"answer": answer, "citations": citations}

    async def chat_stream(self, query: str, history=None, limit: int = 8, note: dict | None = None):
        import litellm

        context, citations = await self._chat_context(query, limit, note)
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
