"""Spike: prove khora can extract + embed + recall entirely through llama.cpp.

Validates the load-bearing assumption of the Uru design: that khora (which only
ever talks to one OPENAI_API_BASE) can be driven by local llama.cpp servers via
the two-server + proxy bridge, with the embedded sqlite_lance backend, fully
offline and with no cloud API key.

Run:  uv run --project . python scripts/spike.py
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
MODELS_DIR = HERE / ".models"
WORK_DIR = HERE / ".spike-work"

CHAT_REPO = "bartowski/Qwen2.5-3B-Instruct-GGUF"
CHAT_FILE = "Qwen2.5-3B-Instruct-Q4_K_M.gguf"
EMBED_REPO = "nomic-ai/nomic-embed-text-v1.5-GGUF"
EMBED_FILE = "nomic-embed-text-v1.5.f16.gguf"
EMBED_DIM = 768

FIXTURE = """\
# Project Uru

Uru is an Obsidian plugin being built by Archie at DeytaHQ. It uses the khora
library for knowledge-graph extraction and vector search. khora was written in
Python and runs locally with llama.cpp, so notes never leave the laptop.
Archie lives in Belgrade and previously worked on the Khora knowledge engine.
"""

ENTITY_TYPES = ["PERSON", "ORGANIZATION", "CONCEPT", "LOCATION", "TECHNOLOGY", "PRODUCT"]
REL_TYPES = ["WORKS_FOR", "USES", "LOCATED_IN", "CREATED_BY", "PART_OF", "RELATED_TO"]


def download_models() -> tuple[Path, Path]:
    from huggingface_hub import hf_hub_download

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[models] downloading {CHAT_FILE} ...")
    chat = hf_hub_download(CHAT_REPO, CHAT_FILE, local_dir=MODELS_DIR)
    print(f"[models] downloading {EMBED_FILE} ...")
    embed = hf_hub_download(EMBED_REPO, EMBED_FILE, local_dir=MODELS_DIR)
    return Path(chat), Path(embed)


async def main() -> int:
    from uru_sidecar.llama import LlamaServer, free_port

    chat_path, embed_path = download_models()

    chat = LlamaServer(chat_path, WORK_DIR, alias="uru-chat", n_ctx=8192)
    embed = LlamaServer(embed_path, WORK_DIR, alias="uru-embed", embedding=True, n_ctx=2048)

    proxy_port = free_port()
    proxy_base = f"http://127.0.0.1:{proxy_port}/v1"

    import uvicorn
    from fastapi import FastAPI

    from uru_sidecar.proxy import build_proxy_router

    print("[llama] starting chat + embed servers (Metal)...")
    t0 = time.perf_counter()
    chat.start()
    embed.start()
    chat.wait_ready()
    embed.wait_ready()
    print(f"[llama] both servers ready in {time.perf_counter() - t0:.1f}s")

    app = FastAPI()
    app.include_router(build_proxy_router(chat.base_url, embed.base_url))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=proxy_port, log_level="warning"))
    proxy_task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    print(f"[proxy] up at {proxy_base}")

    # Point khora's LiteLLM at the proxy. No api_base field in khora -> env only.
    os.environ.update(
        {
            "OPENAI_API_BASE": proxy_base,
            "OPENAI_BASE_URL": proxy_base,
            "OPENAI_API_KEY": "sk-noop",
            "KHORA_STORAGE_BACKEND": "sqlite_lance",
            "KHORA_STORAGE_SQLITE_LANCE_DB_PATH": str(WORK_DIR / "uru.db"),
            "KHORA_STORAGE_SQLITE_LANCE_EMBEDDING_DIMENSION": str(EMBED_DIM),
            "KHORA_LLM_MODEL": "openai/uru-chat",
            "KHORA_LLM_EMBEDDING_MODEL": "openai/uru-embed",
            "KHORA_LLM_EMBEDDING_DIMENSION": str(EMBED_DIM),
            "KHORA_PIPELINES_EXTRACT_ENTITIES": "true",
        }
    )

    rc = 1
    try:
        from khora import Khora

        kb = Khora(run_migrations=True)
        await kb.connect()
        print("[khora] connected (sqlite_lance)")

        ns = await kb.create_namespace(metadata={"label": "uru-spike"})
        ns_id = ns.namespace_id
        print(f"[khora] namespace {ns_id}")

        t1 = time.perf_counter()
        rem = await kb.remember(
            FIXTURE,
            namespace=ns_id,
            title="Project Uru",
            external_id="Projects/Uru.md",
            entity_types=ENTITY_TYPES,
            relationship_types=REL_TYPES,
        )
        print(
            f"[remember] {time.perf_counter() - t1:.1f}s | chunks={rem.chunks_created} "
            f"entities={rem.entities_extracted} rels={rem.relationships_created}"
        )

        t2 = time.perf_counter()
        res = await kb.recall("Who builds Uru and what does it use?", namespace=ns_id, limit=5)
        print(f"[recall] {time.perf_counter() - t2:.1f}s | chunks={len(res.chunks)} "
              f"entities={len(res.entities)} docs={len(res.documents)}")

        for c in res.chunks[:3]:
            doc = next((d for d in res.documents if d.id == c.document_id), None)
            ext = getattr(doc, "external_id", "?") if doc else "?"
            print(f"   - score={c.score:.3f} src={ext} :: {c.content[:70].strip()!r}")
        if res.entities:
            print("   entities:", ", ".join(f"{e.name}({e.entity_type})" for e in res.entities[:8]))

        # Success criteria: embeddings worked (chunks recalled) and linkback resolves.
        linkback_ok = any(d.external_id == "Projects/Uru.md" for d in res.documents)
        if res.chunks and linkback_ok:
            print("\nSPIKE PASS: khora extract+embed+recall works through llama.cpp; "
                  f"linkback external_id resolved; entities_extracted={rem.entities_extracted}")
            rc = 0
        else:
            print("\nSPIKE FAIL: chunks or linkback missing")
        await kb.disconnect()
    finally:
        server.should_exit = True
        await proxy_task
        chat.stop()
        embed.stop()
    return rc


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
