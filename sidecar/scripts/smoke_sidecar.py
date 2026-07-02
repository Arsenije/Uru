"""Smoke-test the real sidecar: spawn it, poll /health, remember, recall, shutdown.

Uses the already-cached spike models (Qwen chat + nomic embed @768) just to
exercise the HTTP plumbing — the production default embed model is bge-m3@1024.

Run:  PYTHONPATH=. .venv/bin/python scripts/smoke_sidecar.py
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent.parent
MODELS = HERE / ".models"
WORK = HERE / ".smoke-bge-m3"  # fresh DB: bge-m3 is 1024-dim, not nomic's 768
TOKEN = "smoke-token"
PORT = 8719
EMBED_MODEL = MODELS / "bge-m3-Q8_0.gguf"
EMBED_DIM = "1024"
LLAMA_SERVER = HERE / ".llamacpp-test" / "llama-b9838" / "llama-server"

FIXTURE = (
    "Uru is an Obsidian plugin by Archie at DeytaHQ. It uses khora for "
    "knowledge-graph extraction and runs locally with llama.cpp."
)


def main() -> int:
    WORK.mkdir(exist_ok=True)
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uru_sidecar",
            "--port", str(PORT),
            "--token", TOKEN,
            "--db-path", str(WORK / "uru.db"),
            "--llama-server", str(LLAMA_SERVER),
            "--chat-model", str(MODELS / "Qwen2.5-3B-Instruct-Q4_K_M.gguf"),
            "--embed-model", str(EMBED_MODEL),
            "--embedding-dimension", EMBED_DIM,
        ],
        cwd=HERE,
    )
    base = f"http://127.0.0.1:{PORT}"
    auth = {"Authorization": f"Bearer {TOKEN}"}
    rc = 1
    try:
        # 1) /health reachable immediately, becomes "ok" after model load.
        deadline = time.time() + 300
        status = None
        while time.time() < deadline:
            if proc.poll() is not None:
                print("FAIL: sidecar exited early")
                return 1
            try:
                h = httpx.get(f"{base}/health", timeout=3).json()
                status = h.get("status")
                if status in ("ok", "error"):
                    print(f"[health] {h}")
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)
        if status != "ok":
            print(f"FAIL: sidecar not ok (status={status})")
            return 1

        # 2) auth is enforced
        unauth = httpx.post(f"{base}/recall", json={"query": "x"}, timeout=10)
        assert unauth.status_code == 401, f"expected 401, got {unauth.status_code}"
        print("[auth] unauthorized correctly rejected")

        # 3) remember
        r = httpx.post(
            f"{base}/remember",
            headers=auth,
            json={"external_id": "Notes/Uru.md", "title": "Uru", "content": FIXTURE},
            timeout=120,
        ).json()
        print(f"[remember] {r}")
        assert r["chunks_created"] >= 1

        # 4) recall + linkback
        res = httpx.post(
            f"{base}/recall", headers=auth,
            json={"query": "What does Uru use?", "limit": 5}, timeout=120,
        ).json()
        ext_ids = [d["external_id"] for d in res["documents"]]
        print(f"[recall] chunks={len(res['chunks'])} entities={len(res['entities'])} docs={ext_ids}")
        assert res["chunks"], "no chunks returned"
        assert "Notes/Uru.md" in ext_ids, "linkback external_id missing"

        # 5) forget
        f = httpx.post(f"{base}/forget", headers=auth, json={"external_id": "Notes/Uru.md"}, timeout=30).json()
        print(f"[forget] {f}")
        assert f["deleted"] is True

        print("\nSIDECAR SMOKE PASS")
        rc = 0
    finally:
        try:
            httpx.post(f"{base}/shutdown", headers=auth, timeout=10)
        except httpx.HTTPError:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
