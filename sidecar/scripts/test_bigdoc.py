"""Reproduce the failing case: a large multi-chunk note via /remember.

Confirms the concurrency=1 + raised-timeout fix lets a big document finish
extraction instead of the 30s-timeout retry storm seen in the field log.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent.parent
MODELS = HERE / ".models"
WORK = HERE / ".bigdoc-test"
TOKEN = "big-token"
PORT = 8731

# ~30 distinct paragraphs → many chunks, like the 31-chunk doc that hung.
PARAS = [
    f"Section {i}: {topic} was a pivotal development. "
    f"It involved {who} working at {org} in {place}, advancing {field}."
    for i, (topic, who, org, place, field) in enumerate(
        [
            ("The printing press", "Johannes Gutenberg", "Mainz workshop", "Germany", "mass communication"),
            ("The steam engine", "James Watt", "Boulton & Watt", "Scotland", "industrial power"),
            ("The telephone", "Alexander Graham Bell", "Bell Telephone", "Boston", "telecommunications"),
            ("The light bulb", "Thomas Edison", "Menlo Park lab", "New Jersey", "electric lighting"),
            ("Radioactivity", "Marie Curie", "University of Paris", "France", "nuclear physics"),
            ("Relativity", "Albert Einstein", "Patent Office", "Bern", "theoretical physics"),
            ("Penicillin", "Alexander Fleming", "St Mary's Hospital", "London", "antibiotics"),
            ("The transistor", "William Shockley", "Bell Labs", "New Jersey", "electronics"),
            ("DNA structure", "Watson and Crick", "Cavendish Lab", "Cambridge", "molecular biology"),
            ("The microprocessor", "Federico Faggin", "Intel", "California", "computing"),
        ]
        * 3
    )
]
BIG = "# History of Invention\n\n" + "\n\n".join(PARAS)


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
        print(f"[ready] indexing big note ({len(BIG)} chars)…")

        t0 = time.perf_counter()
        r = httpx.post(
            f"{base}/remember", headers=auth,
            json={"external_id": "History.md", "title": "History", "content": BIG},
            timeout=900,
        )
        dt = time.perf_counter() - t0
        print(f"[remember] HTTP {r.status_code} in {dt:.0f}s")
        if r.status_code != 200:
            print("FAIL:", r.text[:300])
            return 1
        body = r.json()
        print(f"[remember] {body}")
        ok = body.get("chunks_created", 0) >= 1
        print("\nBIGDOC PASS" if ok else "\nBIGDOC FAIL")
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
