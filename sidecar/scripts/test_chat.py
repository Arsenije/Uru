"""Test the /chat RAG endpoint (streaming + non-streaming) against a live sidecar."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent.parent
MODELS = HERE / ".models"
WORK = HERE / ".chat-test"
TOKEN = "chat-token"
PORT = 8741

DOCS = [
    {"external_id": "Curie.md", "title": "Marie Curie",
     "content": "Marie Curie was a physicist and chemist who won Nobel Prizes in Physics (1903) and Chemistry (1911). She discovered polonium and radium."},
    {"external_id": "Einstein.md", "title": "Albert Einstein",
     "content": "Albert Einstein developed the theory of relativity and won the 1921 Nobel Prize in Physics for the photoelectric effect."},
]


def main() -> int:
    WORK.mkdir(exist_ok=True)
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uru_sidecar",
            "--port", str(PORT), "--token", TOKEN,
            "--db-path", str(WORK / "uru.db"),
            "--chat-model", str(MODELS / "Qwen2.5-3B-Instruct-Q4_K_M.gguf"),
            "--embed-model", str(MODELS / "gguf" / "mxbai-embed-large-v1-f16.gguf"),
            "--embedding-dimension", "1024",
        ],
        cwd=HERE,
    )
    base = f"http://127.0.0.1:{PORT}"
    auth = {"Authorization": f"Bearer {TOKEN}"}
    try:
        deadline = time.time() + 300
        while time.time() < deadline:
            if proc.poll() is not None:
                print("FAIL: exited early")
                return 1
            try:
                if httpx.get(f"{base}/health", timeout=3).json().get("status") == "ok":
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)

        for d in DOCS:
            httpx.post(f"{base}/remember", headers=auth, json=d, timeout=180)
        print("[ready] indexed fixtures")

        q = "Who won a Nobel Prize in Chemistry and what did they discover?"

        print("\n--- non-streaming ---")
        r = httpx.post(f"{base}/chat", headers=auth,
                       json={"query": q, "stream": False}, timeout=300).json()
        print("answer:", r["answer"][:300])
        print("citations:", r["citations"])

        print("\n--- streaming ---")
        sources = None
        toks = []
        with httpx.stream("POST", f"{base}/chat", headers=auth,
                          json={"query": q, "stream": True}, timeout=300) as resp:
            print("http", resp.status_code)
            for line in resp.iter_lines():
                if not line:
                    continue
                ev = json.loads(line)
                if ev["event"] == "sources":
                    sources = ev["citations"]
                elif ev["event"] == "token":
                    toks.append(ev["text"])
        print("sources:", sources)
        print("streamed answer:", "".join(toks)[:300])
        print("\n--- current-note scope (no recall) ---")
        note = {
            "external_id": "Secret.md", "title": "Secret",
            "content": "The passphrase for the vault is 'open-sesame-1971'.",
        }
        rn = httpx.post(f"{base}/chat", headers=auth,
                        json={"query": "What is the passphrase?", "stream": False, "note": note},
                        timeout=300).json()
        print("note answer:", rn["answer"][:200])
        print("note citations:", rn["citations"])
        note_ok = "1971" in rn["answer"] and rn["citations"][0]["external_id"] == "Secret.md"

        ok = bool(r["answer"]) and bool(toks) and bool(r["citations"]) and note_ok
        print("\nCHAT PASS" if ok else "\nCHAT FAIL")
        return 0 if ok else 1
    finally:
        try:
            httpx.post(f"{base}/shutdown", headers=auth, timeout=10)
        except httpx.HTTPError:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
