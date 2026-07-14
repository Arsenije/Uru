"""Runtime configuration for the Uru sidecar, assembled from CLI args + env."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path


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
    # Generous context for RAG chat: retrieved chunks + history + a 4096-token
    # answer budget fit with margin (Qwen2.5-3B natively supports 32k; ~720MB KV
    # cache at 20480 — fine on a 16GB Mac).
    n_ctx_chat: int = 20480
    n_ctx_embed: int = 2048
    n_gpu_layers: int = -1
    host: str = "127.0.0.1"

    # Local-inference tuning. llama.cpp serves one request at a time, so keep
    # khora's calls serialized and give each one room.
    llm_timeout: int = 300
    llm_max_concurrent: int = 1
    llm_max_retries: int = 2
    llm_max_tokens: int = 4096

    # Self-shutdown if the plugin stops heartbeating (prevents orphaned backends
    # when Obsidian is force-quit). 0 disables.
    idle_timeout: int = 120

    # TEMPORARY testing aid. When set (e.g. "gpt-4o-mini"), the proxy routes
    # chat/completions to real OpenAI using OPENAI_API_KEY from the environment,
    # instead of the local chat model. Embeddings stay local on bge-m3
    # (dimension unchanged). Not for production/offline use.
    openai_model: str | None = None

    # Debug aid: append every chat-completion request/response to this JSONL
    # file, verbatim. Off by default (unbounded growth) — opt in with
    # --debug-log-path when investigating chat behavior offline.
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
        p.add_argument("--n-gpu-layers", type=int, default=-1)
        p.add_argument("--idle-timeout", type=int, default=120)
        p.add_argument(
            "--debug-log-path", type=Path, default=None,
            help="Append every chat-completion request/response to this JSONL file, verbatim.",
        )
        p.add_argument(
            "--openai-model", default=None,
            help="TEMP: route chat/completions to real OpenAI (e.g. gpt-4o-mini) using "
                 "OPENAI_API_KEY from env; embeddings stay local. For testing only.",
        )
        p.add_argument(
            "--llm-concurrency", type=int, default=1,
            help="Max concurrent LLM calls. Keep 1 for the local single-threaded "
                 "llama.cpp; raise (e.g. 8) only when --openai-model routes to a "
                 "cloud model that tolerates parallelism.",
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
            n_gpu_layers=ns.n_gpu_layers,
            idle_timeout=ns.idle_timeout,
            debug_log_path=ns.debug_log_path,
            openai_model=ns.openai_model,
            llm_max_concurrent=ns.llm_concurrency,
        )

    def khora_env(self, openai_base: str) -> dict[str, str]:
        """The KHORA_*/OpenAI env that points khora at the embedded stack + proxy."""
        return {
            "OPENAI_API_BASE": openai_base,
            "OPENAI_BASE_URL": openai_base,
            # The sidecar token doubles as the proxy's api key, so khora/litellm
            # authenticate to it. "sk-noop" placeholder only in tokenless dev
            # runs (litellm rejects an empty key before sending).
            "OPENAI_API_KEY": self.token or "sk-noop",
            "KHORA_STORAGE_BACKEND": "sqlite_lance",
            "KHORA_STORAGE_SQLITE_LANCE_DB_PATH": str(self.db_path),
            "KHORA_STORAGE_SQLITE_LANCE_EMBEDDING_DIMENSION": str(self.embedding_dimension),
            "KHORA_LLM_MODEL": "openai/uru-chat",
            "KHORA_LLM_EMBEDDING_MODEL": "openai/uru-embed",
            "KHORA_LLM_EMBEDDING_DIMENSION": str(self.embedding_dimension),
            "KHORA_LLM_TIMEOUT": str(self.llm_timeout),
            "KHORA_LLM_MAX_CONCURRENT_LLM_CALLS": str(self.llm_max_concurrent),
            "KHORA_LLM_MAX_RETRIES": str(self.llm_max_retries),
            "KHORA_LLM_MAX_TOKENS": str(self.llm_max_tokens),
            # Vector search + chat only — Uru never runs khora's LLM entity
            # extraction, so notes index at embedding speed.
            "KHORA_PIPELINES_EXTRACT_ENTITIES": "false",
            # Disable khora's cross-encoder reranking (on by default). Its model,
            # BAAI/bge-reranker-v2-m3, is NOT among the models we download, so the
            # stage adds ~1.4s to EVERY recall while doing nothing useful (measured:
            # recall drops 1.5s → ~11ms with this off). Re-enable only if we also
            # ship the reranker model and accept the latency.
            "KHORA_QUERY_ENABLE_RERANKING": "false",
        }
