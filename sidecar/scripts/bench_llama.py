"""Benchmark llama.cpp chat + embedding throughput for the models this plugin ships.

Boots the same two single-model llama-server processes uru_sidecar runs in
production (see uru_sidecar/llama.py) and drives them directly over HTTP — no
khora/proxy in the loop — so the numbers reflect raw llama.cpp performance on
this machine for the exact models + quantizations pinned in
src/bootstrap/uv.ts (the ones the plugin actually downloads for users):

    chat:  bartowski/Qwen2.5-3B-Instruct-GGUF · Qwen2.5-3B-Instruct-Q4_K_M.gguf
    embed: lm-kit/bge-m3-gguf · bge-m3-Q8_0.gguf

Reports prompt (prefill) and generation (decode) tokens/sec for the chat
model from llama.cpp's own ``timings`` block (not a wall-clock estimate),
plus embedding tokens/sec and batch throughput.

Run:
    cd sidecar && uv run --project . python scripts/bench_llama.py
    cd sidecar && uv run --project . python scripts/bench_llama.py --quick
    cd sidecar && uv run --project . python scripts/bench_llama.py --json bench.json
    cd sidecar && uv run --project . python scripts/bench_llama.py --n-gpu-layers 0  # CPU-only baseline

A full run downloads ~3 GB of models on first use (cached under .models/
after that) and takes a few minutes to run the whole matrix; use --quick for
a faster sanity check.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = HERE / ".models"
WORK_DIR = HERE / ".bench-work"

# Pinned models — mirrors src/bootstrap/uv.ts (the production download), so
# these numbers reflect what actually ships, not an arbitrary GGUF.
CHAT_REPO = "bartowski/Qwen2.5-3B-Instruct-GGUF"
CHAT_FILE = "Qwen2.5-3B-Instruct-Q4_K_M.gguf"
CHAT_REVISION = "f302c64a2269a69fb27b2f9473b362f5bb8e78d8"
EMBED_REPO = "lm-kit/bge-m3-gguf"
EMBED_FILE = "bge-m3-Q8_0.gguf"
EMBED_REVISION = "9379ce497e8814b200f2dc0d18eb4045426dcb8c"


# ---- filler text for synthetic prompts -------------------------------------

_FILLER_SENTENCES = [
    "The history of computing spans many decades of incremental innovation.",
    "Local-first software keeps a user's data on-device instead of a remote server.",
    "A knowledge graph links entities and relationships extracted from text.",
    "Vector embeddings place semantically similar passages close together in space.",
    "Large language models generate text token by token, conditioned on prior context.",
    "Quantized weights trade a little accuracy for much lower memory use.",
    "Metal acceleration lets Apple Silicon run inference without a discrete GPU.",
    "A retrieval-augmented pipeline grounds generation in retrieved passages.",
]


def _filler(n_sentences: int) -> str:
    return " ".join(_FILLER_SENTENCES[i % len(_FILLER_SENTENCES)] for i in range(n_sentences))


# ---- app-data runtime discovery (mirrors src/paths.ts) --------------------


def _app_data_runtime_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "uru" / "runtime"


def find_llama_server(override: Path | None) -> Path:
    if override:
        if not override.is_file():
            raise SystemExit(f"--llama-server not found: {override}")
        return override
    for root in (HERE / ".llamacpp-test", _app_data_runtime_dir() / "llama.cpp"):
        if not root.exists():
            continue
        for p in sorted(root.rglob("llama-server")):
            if p.is_file():
                return p
    raise SystemExit(
        "llama-server binary not found under sidecar/.llamacpp-test or the app-data "
        "runtime dir. Run the Obsidian plugin once to bootstrap it, or pass "
        "--llama-server /path/to/llama-server explicitly."
    )


def ensure_models(models_dir: Path | None) -> tuple[Path, Path]:
    """Reuse an already-cached pinned model, else download it into models_dir."""
    from huggingface_hub import hf_hub_download

    if models_dir is None:
        cached = DEFAULT_MODELS_DIR / CHAT_FILE
        app_data = _app_data_runtime_dir() / "models"
        models_dir = DEFAULT_MODELS_DIR if cached.exists() or not (app_data / CHAT_FILE).exists() else app_data

    models_dir.mkdir(parents=True, exist_ok=True)
    chat = models_dir / CHAT_FILE
    if not chat.exists():
        print(f"[models] downloading {CHAT_FILE} (one time, cached under {models_dir})...")
        chat = Path(hf_hub_download(CHAT_REPO, CHAT_FILE, revision=CHAT_REVISION, local_dir=models_dir))
    embed = models_dir / EMBED_FILE
    if not embed.exists():
        print(f"[models] downloading {EMBED_FILE} (one time, cached under {models_dir})...")
        embed = Path(hf_hub_download(EMBED_REPO, EMBED_FILE, revision=EMBED_REVISION, local_dir=models_dir))
    return chat, embed


# ---- chat: raw completion timings ------------------------------------------


@dataclass
class Sample:
    prompt_tokens: int
    predicted_tokens: int
    prompt_tps: float
    predicted_tps: float
    wall_s: float


def run_completion(base_url: str, prompt: str, n_predict: int, timeout: float = 300.0) -> Sample:
    t0 = time.perf_counter()
    r = httpx.post(
        f"{base_url}/completion",
        json={
            "prompt": prompt,
            "n_predict": n_predict,
            "temperature": 0.0,
            "stream": False,
            "cache_prompt": False,  # pay full prefill cost every call, for a clean measurement
            "ignore_eos": True,  # force exactly n_predict decode steps, so samples are comparable
        },
        timeout=timeout,
    )
    wall = time.perf_counter() - t0
    r.raise_for_status()
    data = r.json()
    t = data.get("timings")
    if t is None:  # defensive: older/newer llama.cpp builds might shape this differently
        predicted_n = data.get("tokens_predicted", n_predict)
        return Sample(
            prompt_tokens=data.get("tokens_evaluated", 0),
            predicted_tokens=predicted_n,
            prompt_tps=float("nan"),
            predicted_tps=(predicted_n / wall) if wall else 0.0,
            wall_s=wall,
        )
    return Sample(
        prompt_tokens=t["prompt_n"],
        predicted_tokens=t["predicted_n"],
        prompt_tps=t["prompt_per_second"],
        predicted_tps=t["predicted_per_second"],
        wall_s=wall,
    )


def bench_completion(base_url: str, prompt: str, n_predict: int, *, repeats: int, warmup: int) -> list[Sample]:
    for _ in range(warmup):
        run_completion(base_url, prompt, n_predict)
    return [run_completion(base_url, prompt, n_predict) for _ in range(repeats)]


def _stats(values: list[float]) -> tuple[float, float, float]:
    return statistics.mean(values), statistics.median(values), (statistics.pstdev(values) if len(values) > 1 else 0.0)


def stream_ttft(base_url: str, prompt: str, n_predict: int, timeout: float = 300.0) -> tuple[float, Sample]:
    """Time-to-first-token over the streaming native /completion endpoint."""
    t0 = time.perf_counter()
    ttft = None
    final: dict = {}
    with httpx.stream(
        "POST",
        f"{base_url}/completion",
        json={
            "prompt": prompt,
            "n_predict": n_predict,
            "temperature": 0.0,
            "stream": True,
            "cache_prompt": False,
            "ignore_eos": True,
        },
        timeout=timeout,
    ) as resp:
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[len("data: "):]
            if payload == "[DONE]":
                break
            if ttft is None:
                ttft = time.perf_counter() - t0
            chunk = json.loads(payload)
            if chunk.get("stop"):
                final = chunk
    wall = time.perf_counter() - t0
    t = final.get("timings", {})
    sample = Sample(
        prompt_tokens=t.get("prompt_n", 0),
        predicted_tokens=t.get("predicted_n", n_predict),
        prompt_tps=t.get("prompt_per_second", float("nan")),
        predicted_tps=t.get("predicted_per_second", float("nan")),
        wall_s=wall,
    )
    return ttft or wall, sample


# ---- embeddings -------------------------------------------------------------


@dataclass
class EmbedSample:
    n_texts: int
    total_tokens: int
    wall_s: float

    @property
    def texts_per_s(self) -> float:
        return self.n_texts / self.wall_s if self.wall_s else 0.0

    @property
    def tokens_per_s(self) -> float:
        return self.total_tokens / self.wall_s if self.wall_s and self.total_tokens else 0.0


def run_embeddings(base_url: str, texts: list[str], timeout: float = 120.0) -> EmbedSample:
    t0 = time.perf_counter()
    r = httpx.post(f"{base_url}/v1/embeddings", json={"model": "uru-embed", "input": texts}, timeout=timeout)
    wall = time.perf_counter() - t0
    r.raise_for_status()
    data = r.json()
    total_tokens = data.get("usage", {}).get("total_tokens", 0)
    return EmbedSample(n_texts=len(texts), total_tokens=total_tokens, wall_s=wall)


# ---- console output ---------------------------------------------------------


def print_table(title: str, headers: list[str], rows: list[list[str]]) -> None:
    print(f"\n=== {title} ===")
    if not rows:
        print("(skipped)")
        return
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]

    def fmt(cells: list[str]) -> str:
        return "  ".join(c.ljust(w) for c, w in zip(cells, widths))

    print(fmt(headers))
    print(fmt(["-" * w for w in widths]))
    for r in rows:
        print(fmt(r))


# ---- benchmark sections ------------------------------------------------------

PREFILL_CASES = [("short", 4), ("medium", 40), ("long", 150), ("xlong", 400)]
PREFILL_N_PREDICT = 16  # small — we only care about the prompt-eval phase here

DECODE_N_PREDICT = [32, 128, 512]
DECODE_PROMPT_SENTENCES = 4  # short, fixed prompt — isolates steady-state decode speed

# Approximate real sidecar traffic shapes (see lifecycle.py): an extraction
# call over one note chunk, and a RAG chat answer over several recalled chunks.
REALISTIC_CASES = [
    ("extraction-like (~600 tok in, 128 out)", 40, 128),
    ("rag-chat-like (~2000 tok in, 256 out)", 150, 256),
]

EMBED_LATENCY_CASES = [("short", 2), ("medium", 15), ("long", 60), ("xlong", 140)]
EMBED_BATCH_SIZES = [1, 4, 8, 16, 32]
EMBED_BATCH_TEXT_SENTENCES = 6  # bge-m3 trains at 8192 tok, so the real ceiling per
# sequence is the configured --n-ctx-embed (2048 by default) rather than the model
# itself — batch=32 here intentionally exceeds that, to exercise the graceful-skip
# path below. (mxbai-embed-large-v1, the previous default, only trained at 512 tok
# and llama-server capped capacity to that regardless of --n-ctx-embed — the "long"
# case above used to fail outright on that model.)


def bench_chat(base_url: str, args: argparse.Namespace, results: list[dict]) -> None:
    prefill_cases = PREFILL_CASES if not args.quick else PREFILL_CASES[:2]
    decode_n = DECODE_N_PREDICT if not args.quick else DECODE_N_PREDICT[:2]
    repeats, warmup = args.repeats, args.warmup

    rows = []
    for label, n_sentences in prefill_cases:
        samples = bench_completion(base_url, _filler(n_sentences), PREFILL_N_PREDICT, repeats=repeats, warmup=warmup)
        mean, median, stdev = _stats([s.prompt_tps for s in samples])
        rows.append([label, str(samples[0].prompt_tokens), f"{mean:.1f}", f"{median:.1f}", f"{stdev:.1f}"])
        results.append({
            "section": "chat_prefill", "label": label, "prompt_tokens": samples[0].prompt_tokens,
            "prefill_tps_mean": mean, "prefill_tps_median": median, "prefill_tps_stdev": stdev,
        })
    print_table("Chat: prefill (prompt eval) TPS vs prompt length", ["case", "prompt_tok", "mean tok/s", "median", "stdev"], rows)

    rows = []
    prompt = _filler(DECODE_PROMPT_SENTENCES)
    for n_predict in decode_n:
        samples = bench_completion(base_url, prompt, n_predict, repeats=repeats, warmup=warmup)
        mean, median, stdev = _stats([s.predicted_tps for s in samples])
        rows.append([str(n_predict), str(samples[0].predicted_tokens), f"{mean:.1f}", f"{median:.1f}", f"{stdev:.1f}"])
        results.append({
            "section": "chat_decode", "label": f"n_predict={n_predict}", "predicted_tokens": samples[0].predicted_tokens,
            "decode_tps_mean": mean, "decode_tps_median": median, "decode_tps_stdev": stdev,
        })
    print_table("Chat: decode (generation) TPS vs generation length", ["n_predict", "gen_tok", "mean tok/s", "median", "stdev"], rows)

    rows = []
    for label, n_sentences, n_predict in REALISTIC_CASES:
        samples = bench_completion(base_url, _filler(n_sentences), n_predict, repeats=max(2, repeats // 2), warmup=warmup)
        p_mean, _, p_stdev = _stats([s.prompt_tps for s in samples])
        d_mean, _, d_stdev = _stats([s.predicted_tps for s in samples])
        rows.append([
            label, str(samples[0].prompt_tokens), str(samples[0].predicted_tokens),
            f"{p_mean:.1f}", f"{d_mean:.1f}",
        ])
        results.append({
            "section": "chat_realistic", "label": label,
            "prompt_tokens": samples[0].prompt_tokens, "predicted_tokens": samples[0].predicted_tokens,
            "prefill_tps_mean": p_mean, "prefill_tps_stdev": p_stdev,
            "decode_tps_mean": d_mean, "decode_tps_stdev": d_stdev,
        })
    print_table("Chat: realistic sidecar-shaped workloads", ["case", "prompt_tok", "gen_tok", "prefill tok/s", "decode tok/s"], rows)

    label, n_sentences, n_predict = REALISTIC_CASES[-1]
    ttft, sample = stream_ttft(base_url, _filler(n_sentences), n_predict)
    print_table(
        "Chat: time-to-first-token (streaming, as the chat UI experiences it)",
        ["case", "ttft_ms", "gen_tok", "decode tok/s"],
        [[label, f"{ttft * 1000:.0f}", str(sample.predicted_tokens), f"{sample.predicted_tps:.1f}"]],
    )
    results.append({
        "section": "chat_ttft", "label": label, "ttft_ms": ttft * 1000,
        "predicted_tokens": sample.predicted_tokens, "decode_tps": sample.predicted_tps,
    })


def bench_embed(base_url: str, args: argparse.Namespace, results: list[dict]) -> None:
    repeats, warmup = max(2, args.repeats // 2), args.warmup

    rows = []
    for label, n_sentences in EMBED_LATENCY_CASES:
        text = [_filler(n_sentences)]
        try:
            for _ in range(warmup):
                run_embeddings(base_url, text)
            samples = [run_embeddings(base_url, text) for _ in range(repeats)]
        except httpx.HTTPStatusError as exc:
            print(f"[embed-latency] case={label} failed ({exc.response.status_code}); "
                  f"text exceeds either the model's native context or the configured "
                  f"--n-ctx-embed (whichever is smaller). Skipping.")
            continue
        mean, median, stdev = _stats([s.tokens_per_s for s in samples])
        wall_ms = statistics.mean(s.wall_s for s in samples) * 1000
        rows.append([label, str(samples[0].total_tokens), f"{wall_ms:.1f}", f"{mean:.0f}", f"{median:.0f}"])
        results.append({
            "section": "embed_latency", "label": label, "tokens": samples[0].total_tokens,
            "wall_ms_mean": wall_ms, "tokens_per_s_mean": mean, "tokens_per_s_stdev": stdev,
        })
    print_table("Embeddings: single-text latency vs text length", ["case", "tokens", "mean ms", "tok/s mean", "median"], rows)

    rows = []
    batch_sizes = EMBED_BATCH_SIZES if not args.quick else EMBED_BATCH_SIZES[:3]
    for batch in batch_sizes:
        texts = [_filler(EMBED_BATCH_TEXT_SENTENCES)] * batch
        try:
            for _ in range(warmup):
                run_embeddings(base_url, texts)
            samples = [run_embeddings(base_url, texts) for _ in range(repeats)]
        except httpx.HTTPStatusError as exc:
            print(f"[embed-batch] batch={batch} failed ({exc.response.status_code}); "
                  f"combined batch exceeds either the model's native context or the "
                  f"configured --n-ctx-embed (whichever is smaller). Skipping.")
            continue
        mean_tps, _, _ = _stats([s.texts_per_s for s in samples])
        mean_tokps, _, _ = _stats([s.tokens_per_s for s in samples])
        rows.append([str(batch), str(samples[0].total_tokens), f"{mean_tps:.1f}", f"{mean_tokps:.0f}"])
        results.append({
            "section": "embed_batch", "label": f"batch={batch}", "total_tokens": samples[0].total_tokens,
            "texts_per_s_mean": mean_tps, "tokens_per_s_mean": mean_tokps,
        })
    print_table("Embeddings: batch throughput", ["batch", "total_tok", "texts/s", "tok/s"], rows)


# ---- entrypoint --------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--llama-server", type=Path, default=None, help="Path to the llama-server binary (auto-discovered by default).")
    p.add_argument("--models-dir", type=Path, default=None, help="Where to cache/find the pinned GGUFs (default: sidecar/.models).")
    p.add_argument("--n-gpu-layers", type=int, default=-1, help="Matches SidecarConfig's default (-1 = offload all).")
    p.add_argument("--n-ctx-chat", type=int, default=8192)
    p.add_argument("--n-ctx-embed", type=int, default=2048)
    p.add_argument("--repeats", type=int, default=5)
    p.add_argument("--warmup", type=int, default=1)
    p.add_argument("--chat-only", action="store_true")
    p.add_argument("--embed-only", action="store_true")
    p.add_argument("--quick", action="store_true", help="Smaller matrix + fewer repeats, for a fast sanity check.")
    p.add_argument("--json", type=Path, default=None, dest="json_path", help="Write raw results as JSON to this path.")
    args = p.parse_args()

    from uru_sidecar.llama import LlamaServer

    llama_bin = find_llama_server(args.llama_server)
    chat_path, embed_path = ensure_models(args.models_dir)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    chat = LlamaServer(
        llama_bin, chat_path, WORK_DIR, alias="uru-chat",
        n_ctx=args.n_ctx_chat, n_gpu_layers=args.n_gpu_layers,
    )
    embed = LlamaServer(
        llama_bin, embed_path, WORK_DIR, alias="uru-embed", embedding=True,
        n_ctx=args.n_ctx_embed, n_gpu_layers=args.n_gpu_layers,
    )

    results: list[dict] = []
    try:
        print("[llama] starting chat + embed servers...")
        t0 = time.perf_counter()
        if not args.embed_only:
            chat.start()
            chat.wait_ready()
        if not args.chat_only:
            embed.start()
            embed.wait_ready()
        print(f"[llama] ready in {time.perf_counter() - t0:.1f}s "
              f"(n_gpu_layers={args.n_gpu_layers}, n_ctx_chat={args.n_ctx_chat}, n_ctx_embed={args.n_ctx_embed})")

        if not args.embed_only:
            bench_chat(chat.base_url, args, results)
        if not args.chat_only:
            bench_embed(embed.base_url, args, results)
    finally:
        chat.stop()
        embed.stop()

    if args.json_path:
        args.json_path.write_text(json.dumps(results, indent=2))
        print(f"\n[json] wrote {len(results)} result rows to {args.json_path}")

    print("\nBENCH DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
