# Uru

An [Obsidian](https://obsidian.md) plugin that turns your vault into a queryable
**knowledge graph + semantic search index**, powered by the [khora](./khora)
library — running **fully local and offline** via [llama.cpp](https://llama-cpp.com/).

No cloud, no API keys: entity/relationship extraction and embeddings run on local
GGUF models; storage is an embedded SQLite + LanceDB database that never leaves
your machine. Desktop only (it runs a local Python backend).

## Install (beta)

No prerequisites — Uru downloads everything it needs (a Python runtime, the
llama.cpp binary, and the models). Desktop only (macOS / Windows / Linux).

1. Download `uru-v<version>.zip` from the [Releases](../../releases) page.
2. Extract the `uru/` folder into `<your-vault>/.obsidian/plugins/` (so you have
   `.obsidian/plugins/uru/main.js`).
3. In Obsidian: **Settings → Community plugins → enable Uru**.
4. A **setup dialog** opens. Pick **Lite** (fast semantic search) or **Full**
   (also builds a knowledge graph — slower on a local model), then
   **Install & start**. First run downloads ~3 GB; subsequent launches are fast.
5. When the status bar shows **`Uru ✓`**, run **"Uru: Index vault"**, then
   **"Uru: Recall"** or open the **chat** (💬 ribbon icon).

The backend (venv, models, database) lives outside your vault in per-user
app-data, so it survives plugin updates and is never touched by Obsidian Sync.

## Troubleshooting

- **Stuck on "starting" / setup failed** — the setup dialog has a **Copy
  diagnostics** button (also in Settings → Uru). Paste that when reporting an issue.
- **Indexing is slow** — Full-KG runs the chat model on every note (~5–30s each).
  Switch to **Lite** in Settings for near-instant indexing, or use
  **"Uru: Stop indexing"** any time.
- **Start over** — **"Uru: Delete all Uru data"** removes the models, venv, and
  index; re-enable setup from Settings → Uru → "Re-run setup".

## How it works

```
Obsidian plugin (TypeScript)
  → spawns + Bearer-auth HTTP →  uru_sidecar (Python, FastAPI)
                                   ├─ khora (sqlite_lance: SQLite + LanceDB)
                                   └─ proxy → 2× llama.cpp servers (chat + embed)
```

khora is a pure Python library, so the plugin drives it through a local sidecar.
The sidecar runs two single-model llama.cpp servers (a chat model for extraction,
an embedding model) behind a one-URL OpenAI-compatible proxy — see
[`sidecar/`](./sidecar). Default models: `Qwen2.5-3B-Instruct` (chat) and
`mxbai-embed-large-v1` (embeddings, 1024-dim).

## Layout

```
Uru/
├── main.ts              # plugin entry — lifecycle, commands, status
├── src/
│   ├── bootstrap/uv.ts  # uv-based Python/khora bootstrap + model download
│   ├── sidecar/         # process manager + typed HTTP client
│   ├── indexing/        # full + incremental vault indexing (hash-gated)
│   ├── views/           # recall results panel
│   └── settings.ts      # settings tab
├── sidecar/             # Python sidecar (FastAPI + llama.cpp supervisor)
│   └── uru_sidecar/
└── khora/               # vendored khora library
```

## Develop

```bash
npm install
npm run dev          # watch-build main.js
```

The backend bootstraps on first run (uv installs Python 3.13 + khora + llama.cpp
and downloads the models). In this repo a dev venv (`sidecar/.venv`) and cached
models (`sidecar/.models`) are reused automatically if present.

Sidecar tests:

```bash
cd sidecar
PYTHONPATH=. .venv/bin/python scripts/smoke_sidecar.py   # remember→recall→forget
```

## Status

MVP: local backend, full-KG indexing (initial + incremental), semantic recall
panel, settings. See `sidecar/` for the validated khora↔llama.cpp bridge.

## License

MIT
