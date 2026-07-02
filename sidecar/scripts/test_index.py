"""Reproduce the plugin's /index/full (batch SSE) path against a live sidecar."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent.parent
MODELS = HERE / ".models"
WORK = HERE / ".idx-test"
TOKEN = "idx-token"
PORT = 8723


def main() -> int:
    WORK.mkdir(exist_ok=True)
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uru_sidecar",
            "--port", str(PORT), "--token", TOKEN,
            "--db-path", str(WORK / "uru.db"),
            "--chat-model", str(MODELS / "Qwen2.5-3B-Instruct-Q4_K_M.gguf"),
            "--embed-model", str(MODELS / "bge-m3-Q8_0.gguf"),
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
        print("[ready]")

        docs = [
            {"external_id": "A.md", "content": "Ada Lovelace wrote the first algorithm.", "title": "A"},
            {"external_id": "B.md", "content": "Alan Turing defined the Turing machine.", "title": "B"},
        ]
        with httpx.stream("POST", f"{base}/index/full", headers=auth,
                          json={"documents": docs}, timeout=300) as r:
            print("[http]", r.status_code)
            for line in r.iter_lines():
                if line:
                    print("[event]", line)
        return 0
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
