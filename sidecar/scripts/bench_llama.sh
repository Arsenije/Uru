#!/usr/bin/env bash
# Benchmark llama.cpp chat + embedding throughput (TPS) for the pinned models.
# Boots the sidecar's llama-server processes directly (no khora/proxy) and
# reports prefill/decode tokens-per-second plus embedding throughput.
#
# Usage: sidecar/scripts/bench_llama.sh [--quick] [--json bench.json] [--n-gpu-layers 0] ...
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -x .venv/bin/python ]; then
	exec env PYTHONPATH=. .venv/bin/python scripts/bench_llama.py "$@"
else
	exec uv run --project . python scripts/bench_llama.py "$@"
fi
