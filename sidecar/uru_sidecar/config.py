"""Runtime configuration for the Uru sidecar, assembled from CLI args + env."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from pathlib import Path

from .ontology import entity_type_names, relationship_type_names

# Knowledge-graph schema — the single source of truth is uru_sidecar/ontology.py.
# These name lists are what get passed to khora.remember(); the richer
# ExpertiseConfig (descriptions, prompts, confidence) is built from the same module.
DEFAULT_ENTITY_TYPES = entity_type_names()
DEFAULT_RELATIONSHIP_TYPES = relationship_type_names()


@dataclass
class SidecarConfig:
    """Everything the sidecar needs to stand up its stack."""

    port: int
    token: str
    db_path: Path
    llama_server_bin: Path
    chat_model_path: Path
    embed_model_path: Path
    embedding_dimension: int = 1024  # bge-m3 (Q8_0)
    namespace_id: str | None = None
    extract_entities: bool = True
    entity_types: list[str] = field(default_factory=lambda: list(DEFAULT_ENTITY_TYPES))
    relationship_types: list[str] = field(default_factory=lambda: list(DEFAULT_RELATIONSHIP_TYPES))
    # 20480 (Qwen2.5-3B natively supports 32k) so a full extraction batch fits with
    # margin: khora packs input up to max_tokens×3 (=12288), plus the ~600-token
    # prompt template, then generates up to max_tokens (=4096) → ~17000 worst case,
    # comfortably under 20480. At 8192 this overflowed and truncated batched calls
    # (n_tokens=8191, truncated=1). ~720MB KV cache — fine on a 16GB Mac.
    n_ctx_chat: int = 20480
    n_ctx_embed: int = 2048
    n_gpu_layers: int = -1
    host: str = "127.0.0.1"

    # Local-inference tuning. llama.cpp serves one request at a time, so firing
    # khora's default 10 concurrent extraction calls makes them queue and blow
    # the 30s timeout (retry storm → hang). Serialize and give each call room.
    llm_timeout: int = 300
    llm_max_concurrent: int = 1
    llm_max_retries: int = 2
    # Output-token budget for extraction, tuned as a PAIR with n_ctx_chat below.
    # A 2048 cap truncated legitimate large extractions mid-JSON (~2500 tokens for
    # an entity-dense chunk); a full 12000 overshot the other way — khora sizes its
    # input BATCHES at max_tokens × 3 (context-blind), so 12000 → a 36000-token
    # input budget that overflowed the 8192 context window and truncated batched
    # calls (observed: n_tokens=8191, truncated=1). 4096 is the balance: 2× the old
    # output room (covers the ~2856-token real extractions with margin) while
    # input(4096×3=12288) + output(4096) = 16384 fits exactly in n_ctx_chat.
    llm_max_tokens: int = 4096

    # khora's KET-RAG has two independent halves; we keep the first and cut the second.
    #
    # Part 1 — selective_extraction: score chunks by importance and send only the
    # top ~70% to the (expensive) LLM. Keep this ON — it's the cost/speed win.
    selective_extraction: bool = True
    #
    # Part 2 — lightweight co-occurrence edges: the chunks NOT sent to the LLM get
    # cheap rule-based edges via an UNCAPPED combinations() over every capitalized
    # phrase in the chunk. That produced ~990 low-confidence (0.4) CO_OCCURS_WITH
    # edges from a single infobox-heavy note, swamping the real LLM relationships,
    # and the endpoint "entities" are just proper-noun fragments (no lowercase
    # topics). Turn this OFF: skipped chunks contribute nothing to the graph but
    # remain fully vector-searchable (chunking + embedding are unaffected). The
    # engine's own per-chunk co-occurrence (capped at 15/chunk) is a separate,
    # bounded mechanism and is unaffected by this flag.
    lightweight_cooccurrence_edges: bool = False

    # Self-shutdown if the plugin stops heartbeating (prevents orphaned backends
    # when Obsidian is force-quit). 0 disables.
    idle_timeout: int = 120

    # Debug aid: append every chat-completion request/response to this JSONL
    # file, verbatim. Off by default (unbounded growth) — opt in with
    # --debug-log-path when investigating extraction behavior offline.
    debug_log_path: Path | None = None

    @property
    def work_dir(self) -> Path:
        return self.db_path.parent / ".uru-runtime"

    @classmethod
    def from_args(cls, argv: list[str] | None = None) -> SidecarConfig:
        p = argparse.ArgumentParser(prog="uru_sidecar")
        p.add_argument("--port", type=int, required=True)
        p.add_argument("--token", default=os.environ.get("URU_TOKEN", ""))
        p.add_argument("--db-path", required=True, type=Path)
        p.add_argument("--llama-server", required=True, type=Path)
        p.add_argument("--chat-model", required=True, type=Path)
        p.add_argument("--embed-model", required=True, type=Path)
        p.add_argument("--embedding-dimension", type=int, default=1024)
        p.add_argument("--namespace-id", default=None)
        p.add_argument(
            "--no-extract-entities",
            action="store_true",
            help="Embeddings-only 'lite' mode (skips LLM entity extraction).",
        )
        p.add_argument("--n-gpu-layers", type=int, default=-1)
        p.add_argument("--idle-timeout", type=int, default=120)
        p.add_argument(
            "--debug-log-path", type=Path, default=None,
            help="Append every chat-completion request/response to this JSONL file, verbatim.",
        )
        ns = p.parse_args(argv)
        return cls(
            port=ns.port,
            token=ns.token,
            db_path=ns.db_path,
            llama_server_bin=ns.llama_server,
            chat_model_path=ns.chat_model,
            embed_model_path=ns.embed_model,
            embedding_dimension=ns.embedding_dimension,
            namespace_id=ns.namespace_id,
            extract_entities=not ns.no_extract_entities,
            n_gpu_layers=ns.n_gpu_layers,
            idle_timeout=ns.idle_timeout,
            debug_log_path=ns.debug_log_path,
        )

    def khora_env(self, openai_base: str) -> dict[str, str]:
        """The KHORA_*/OpenAI env that points khora at the embedded stack + proxy."""
        return {
            "OPENAI_API_BASE": openai_base,
            "OPENAI_BASE_URL": openai_base,
            "OPENAI_API_KEY": "sk-noop",
            "KHORA_STORAGE_BACKEND": "sqlite_lance",
            "KHORA_STORAGE_SQLITE_LANCE_DB_PATH": str(self.db_path),
            "KHORA_STORAGE_SQLITE_LANCE_EMBEDDING_DIMENSION": str(self.embedding_dimension),
            "KHORA_LLM_MODEL": "openai/uru-chat",
            "KHORA_LLM_EMBEDDING_MODEL": "openai/uru-embed",
            "KHORA_LLM_EMBEDDING_DIMENSION": str(self.embedding_dimension),
            "KHORA_LLM_TIMEOUT": str(self.llm_timeout),
            "KHORA_LLM_MAX_CONCURRENT_LLM_CALLS": str(self.llm_max_concurrent),
            "KHORA_LLM_EXTRACTION_WAVE_SIZE": str(self.llm_max_concurrent),
            "KHORA_LLM_MAX_RETRIES": str(self.llm_max_retries),
            "KHORA_LLM_MAX_TOKENS": str(self.llm_max_tokens),
            "KHORA_PIPELINES_EXTRACT_ENTITIES": "true" if self.extract_entities else "false",
            "KHORA_PIPELINES_SELECTIVE_EXTRACTION": "true" if self.selective_extraction else "false",
            # Disable khora's cross-encoder reranking (on by default). Its model,
            # BAAI/bge-reranker-v2-m3, is NOT among the models we download, so the
            # stage adds ~1.4s to EVERY recall while doing nothing useful (measured:
            # recall drops 1.5s → ~11ms with this off). Re-enable only if we also
            # ship the reranker model and accept the latency.
            "KHORA_QUERY_ENABLE_RERANKING": "false",
        }
