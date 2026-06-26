"""Runtime configuration for the Uru sidecar, assembled from CLI args + env."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from pathlib import Path

# Default knowledge-graph schema (mirrors khora/examples/khora.embedded.yaml).
DEFAULT_ENTITY_TYPES = [
    "PERSON",
    "ORGANIZATION",
    "CONCEPT",
    "LOCATION",
    "EVENT",
    "PRODUCT",
    "TECHNOLOGY",
]
DEFAULT_RELATIONSHIP_TYPES = [
    "WORKS_FOR",
    "USES",
    "LOCATED_IN",
    "CREATED_BY",
    "PART_OF",
    "RELATED_TO",
]


@dataclass
class SidecarConfig:
    """Everything the sidecar needs to stand up its stack."""

    port: int
    token: str
    db_path: Path
    chat_model_path: Path
    embed_model_path: Path
    embedding_dimension: int = 1024  # mxbai-embed-large-v1
    namespace_id: str | None = None
    extract_entities: bool = True
    entity_types: list[str] = field(default_factory=lambda: list(DEFAULT_ENTITY_TYPES))
    relationship_types: list[str] = field(default_factory=lambda: list(DEFAULT_RELATIONSHIP_TYPES))
    n_ctx_chat: int = 8192
    n_ctx_embed: int = 2048
    n_gpu_layers: int = -1
    host: str = "127.0.0.1"

    # Local-inference tuning. llama.cpp serves one request at a time, so firing
    # khora's default 10 concurrent extraction calls makes them queue and blow
    # the 30s timeout (retry storm → hang). Serialize and give each call room.
    llm_timeout: int = 300
    llm_max_concurrent: int = 1
    llm_max_retries: int = 2

    # Self-shutdown if the plugin stops heartbeating (prevents orphaned backends
    # when Obsidian is force-quit). 0 disables.
    idle_timeout: int = 120

    @property
    def work_dir(self) -> Path:
        return self.db_path.parent / ".uru-runtime"

    @classmethod
    def from_args(cls, argv: list[str] | None = None) -> SidecarConfig:
        p = argparse.ArgumentParser(prog="uru_sidecar")
        p.add_argument("--port", type=int, required=True)
        p.add_argument("--token", default=os.environ.get("URU_TOKEN", ""))
        p.add_argument("--db-path", required=True, type=Path)
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
        ns = p.parse_args(argv)
        return cls(
            port=ns.port,
            token=ns.token,
            db_path=ns.db_path,
            chat_model_path=ns.chat_model,
            embed_model_path=ns.embed_model,
            embedding_dimension=ns.embedding_dimension,
            namespace_id=ns.namespace_id,
            extract_entities=not ns.no_extract_entities,
            n_gpu_layers=ns.n_gpu_layers,
            idle_timeout=ns.idle_timeout,
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
            "KHORA_PIPELINES_EXTRACT_ENTITIES": "true" if self.extract_entities else "false",
        }
