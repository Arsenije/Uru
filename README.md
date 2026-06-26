# Uru

An [Obsidian](https://obsidian.md) plugin that turns your vault into a queryable
**knowledge graph + semantic search index**, powered by the [khora](./khora)
library — running **fully local and offline** via [llama.cpp](https://llama-cpp.com/).

No cloud, no API keys: entity/relationship extraction and embeddings run on local
GGUF models; storage is an embedded SQLite + LanceDB database that never leaves
your machine. Desktop only (it runs a local Python backend).

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
