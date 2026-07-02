# Uru

**Ask your Obsidian vault anything — and get answers from what you actually wrote, completely offline.**

Uru turns your [Obsidian](https://obsidian.md) vault into a queryable **knowledge graph + semantic search index**. Drop in your notes and Uru reads them, links the people, projects, and ideas inside, and lets you *recall* or *chat* with the whole vault — with citations back to the exact notes. Everything runs on your own machine via [llama.cpp](https://github.com/ggml-org/llama.cpp); nothing is uploaded.

It's powered by [khora](https://github.com/DeytaHQ/khora), a local-first knowledge-graph + vector-search library. Obsidian can't run Python, so Uru ships a tiny local backend that drives khora for you — you never have to touch it.

<!-- Drop a screenshot of the recall/chat panel here: ![Uru](docs/screenshot.png) -->

## What you can do

- **Recall.** Ask a question and get the most relevant passages from across your vault — semantic, not keyword. Each result links back to its note.
- **Chat with your vault.** A RAG chat panel that answers from your notes and cites them by `[1]`, `[2]`. Scope it to the whole vault or just the current note.
- **Build a knowledge graph.** In Full mode, Uru extracts entities (people, orgs, concepts, places…) and relationships from each note, so recall can follow connections, not just similarity.
- **Index automatically.** New and changed notes are picked up as you write; deletes and renames are handled too. No manual re-sync.
- **Stay private.** No account, no API keys, no network calls after the one-time model download. Your notes never leave your computer.

## Get started

> 💡 **Installing with an AI assistant?** Hand it the [For AI assistants](#for-ai-assistants) section below — it's a deterministic, copy-paste procedure with explicit success checks. Most people install Uru this way.

**Requirements:** Obsidian on **desktop** (macOS / Windows / Linux — Uru runs a local backend, so mobile isn't supported), and **[Node.js](https://nodejs.org) 18+** *only if you build from source*. No Python, no GPU, no manual model setup — Uru downloads everything it needs on first run.

### Install manually

**Option A — prebuilt release (no Node needed):** download **`uru-v<version>.zip`** from the **Assets** section of the [latest release](../../releases/latest) — ⚠️ **not** the "Source code (zip)" link, which omits the built `main.js` and fails to load. Extract the whole `uru/` folder into `<your-vault>/.obsidian/plugins/` (the zip already contains `main.js`, `manifest.json`, `styles.css`, and the `sidecar/` backend).

**Option B — build from source (needs [Node.js](https://nodejs.org) 18+):** one command builds it and copies everything into place:
```bash
git clone https://github.com/Arsenije/Uru.git
cd Uru
npm install
npm run install-plugin -- "<your-vault>"    # builds, then deploys into .obsidian/plugins/uru/
```

Then, either way:

3. **Enable it.** In Obsidian: **Settings → Community plugins → enable Uru**.
4. **Run setup.** A dialog opens — pick **Lite** (fast semantic search) or **Full** (also builds the knowledge graph), then **Install & start**. The first run downloads ~3 GB and sets up a private Python environment. This is one-time; later launches are fast.
5. **Use it.** When the status bar reads **`Uru ✓`**, run the command **"Uru: Index vault"**, then **"Uru: Recall"** or open the chat (💬 ribbon icon).

### For AI assistants

This procedure is safe to run end-to-end. Steps 1–2 are shell commands; steps 3–5 happen inside Obsidian's GUI, so **stop after step 2 and tell the user exactly what to click.**

```
GOAL: Install the Uru Obsidian plugin into the user's vault.

INPUTS YOU NEED FROM THE USER:
  - VAULT  = absolute path to their Obsidian vault (the folder containing `.obsidian/`)

STEP 1 — get the plugin files. Pick ONE:

  Option A — prebuilt release (no Node toolchain needed; prefer this):
    Download the latest `uru-vX.Y.Z.zip` ASSET from
    https://github.com/Arsenije/Uru/releases/latest and extract it so that
    `<VAULT>/.obsidian/plugins/uru/` contains main.js, manifest.json, styles.css.
    IMPORTANT: use the `uru-*.zip` asset, NOT GitHub's "Source code (zip)" — the
    source archive has no built main.js, so the plugin will fail to load.

  Option B — build from source (requires Node.js 18+):
    git clone https://github.com/Arsenije/Uru.git
    cd Uru
    npm install
    npm run install-plugin -- "<VAULT>"   # builds AND copies everything (incl. the
                                          # sidecar/ backend) into .obsidian/plugins/uru/

STEP 2 — VERIFY staging (headless; the last thing you can check before the GUI):
  If you built from source (Option B), run the bundled checker:
    node scripts/verify-staging.mjs "<VAULT>"     # prints "OK: Uru <version> staged ..."
  Otherwise (release-zip install) confirm these exist and are non-empty:
    <VAULT>/.obsidian/plugins/uru/main.js
    <VAULT>/.obsidian/plugins/uru/manifest.json
    <VAULT>/.obsidian/plugins/uru/styles.css
    <VAULT>/.obsidian/plugins/uru/sidecar/pyproject.toml   (backend — must be present)
  Do NOT hand off until this passes.

STEP 3 — HAND OFF TO THE USER (you cannot click Obsidian's UI):
  Tell them: "Open Obsidian → Settings → Community plugins → enable 'Uru'.
  A setup dialog appears — choose Lite (fast) or Full (knowledge graph),
  then click 'Install & start'. The first run downloads ~3 GB; wait for it."

STEP 4 — tell them the success signal:
  The Obsidian status bar shows `Uru ✓`. If it shows `Uru ✕`, the setup
  dialog (and Settings → Uru) has a "Copy diagnostics" button — ask for that text.

STEP 5 — tell them how to use it:
  Run the command "Uru: Index vault", then "Uru: Recall" or the 💬 chat icon.

DO NOT:
  - Try to install on Obsidian mobile (desktop only).
  - Place files outside `<VAULT>/.obsidian/plugins/uru/`.
  - Install Python, llama.cpp, or models by hand — Uru bootstraps them itself.
```

**Facts for assistants** (stable, machine-readable):

| Key | Value |
|---|---|
| Plugin id | `uru` |
| Plugin files to deploy | `main.js`, `manifest.json`, `styles.css`, and `sidecar/` (backend) |
| Deploy target | `<VAULT>/.obsidian/plugins/uru/` |
| Install from source (build + deploy) | `npm install && npm run install-plugin -- "<VAULT>"` |
| Headless staging check | `node scripts/verify-staging.mjs "<VAULT>"` |
| Platforms | macOS, Windows, Linux (desktop only; **no mobile**) |
| Runtime prerequisites | None — Python 3.13, llama.cpp, and models auto-download on first run |
| First-run download | ~3 GB (chat model + embedding model + llama.cpp runtime) |
| Ready signal | Status bar reads `Uru ✓` |
| Error signal | Status bar reads `Uru ✕`; use the "Copy diagnostics" button |
| Backend/data location | Outside the vault, in per-user app-data (see [Privacy](#privacy)) |

## Privacy

This is the whole point of Uru: **everything happens on your own computer.** Entity extraction and embeddings run on local GGUF models through llama.cpp; storage is an embedded SQLite + LanceDB database. No account, no API keys, and — after the one-time model download — no network calls. Your notes are never copied or uploaded.

The backend (the Python environment, models, llama.cpp binary, and the index/database) lives **outside your vault**, in per-user app-data, so it survives plugin updates and is never touched by Obsidian Sync:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/uru` |
| Windows | `%LOCALAPPDATA%\uru` |
| Linux | `$XDG_DATA_HOME/uru` (or `~/.local/share/uru`) |

A small `vaults.json` at the root of that folder tracks which vaults are using the shared
backend, so cleanup never deletes another vault's data out from under it.

**Uninstalling Uru?** It's a two-step process, because Obsidian's plugin remover only deletes
the plugin's own folder inside your vault — it can't reach outside it:

1. In Obsidian, go to **Settings → Uru → Danger zone → "Remove Uru completely"**. This checks
   whether any other vault is still using the shared backend and only deletes what's safe —
   the models, Python environment, and this vault's index.
2. Then remove the plugin as usual from **Settings → Community plugins**.

If Uru is installed in more than one vault, use **"Reset this vault's Uru data"** instead —
it clears just this vault's index and leaves the shared backend for the other vault(s).

If you already removed the plugin without doing step 1, see
[Troubleshooting](#troubleshooting) for how to clean up manually.

## Hardware

| Your setup | What to expect |
|---|---|
| **Apple Silicon (M1–M4)** | Best experience — chat/extraction run on the Metal GPU. Lite indexing is near-instant; Full-KG is comfortably usable. |
| **Intel Macs** | CPU-only. Lite is fine; Full-KG indexing is slow (large vaults take a while). |
| **Windows / Linux** | CPU builds of llama.cpp. Lite is fine; Full-KG is slow — index overnight or use Lite. |
| **Memory** | A few GB of RAM while running (a 3B chat model plus an embedding model stay resident). Closing the panels lets the backend idle-shut-down after ~2 min. |

## Lite vs Full

You choose this at setup and can change it later in **Settings → Uru** (then restart the backend and force-reindex).

- **Lite** — embeddings only. Fast, cheap, near-instant indexing. Great semantic recall and chat. No graph.
- **Full** — everything in Lite **plus** a knowledge graph: Uru runs the chat model on each note (~5–30s per note locally) to extract entities and relationships, so recall can follow connections between notes.

Switching modes re-extracts affected notes automatically on the next **Force re-index** — no manual cleanup needed.

## Troubleshooting

- **Stuck on "starting" / setup failed** — the setup dialog (and Settings → Uru) has a **Copy diagnostics** button. Paste that when reporting an issue.
- **`Uru ✕` after it was working** — an inference server may have crashed; Uru restarts it automatically and the badge returns to `Uru ✓`. If it stays red, grab diagnostics.
- **Indexing is slow** — that's Full-KG running the model on every note. Switch to **Lite** in Settings, or run **"Uru: Stop indexing"** any time.
- **Start over** — Settings → Uru → Danger zone → **"Reset this vault's Uru data"** clears this vault's index (keeps the shared backend); re-enable from Settings → Uru → "Re-run setup".
- **I already removed the plugin and now have leftover files** — Uru couldn't run any cleanup code, since the plugin is gone. Manually delete the per-OS folder from the [Privacy](#privacy) table (e.g. `~/Library/Application Support/uru` on macOS). This is only safe if you're not using Uru in any other vault — if you are, open `uru/vaults.json` to see which `uru/vaults/<id>` subfolder belongs to which vault (by name/path), delete only the ones you no longer need, and leave `uru/runtime` alone.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## How it works (for the curious)

```
Obsidian plugin (TypeScript)
  → spawns + Bearer-auth HTTP →  uru_sidecar (Python, FastAPI)
                                   ├─ khora  (sqlite_lance: SQLite + LanceDB)
                                   └─ proxy → 2× llama.cpp servers (chat + embed)
```

khora is a pure-Python library, so the plugin drives it through a small local **sidecar**. The sidecar runs two single-model `llama-server` processes — a chat model (used for extraction and RAG answers) and an embedding model — behind a one-URL, OpenAI-compatible proxy, then points khora at them. It supervises those processes and restarts either one if it dies, and idle-shuts-down when you're not using Uru.

**Default models** (~3 GB total):
- Chat / extraction: `Qwen2.5-3B-Instruct` (Q4_K_M GGUF)
- Embeddings: `mxbai-embed-large-v1` (f16 GGUF, 1024-dim — this fixes the vector dimension, so changing it requires a full re-index)

<details>
<summary><b>Build & develop from source</b></summary>

```bash
npm install
npm run dev          # watch-build main.js
npm run build        # production build + typecheck
```

The backend bootstraps on first run (`uv` installs Python 3.13 + khora + llama.cpp and downloads the models). In this repo a dev venv (`sidecar/.venv`) and cached models (`sidecar/.models`) are reused automatically **if they match the pinned khora version**; otherwise Uru falls through to a clean app-data bootstrap.

Sidecar smoke test (remember → recall → forget):

```bash
cd sidecar
PYTHONPATH=. .venv/bin/python scripts/smoke_sidecar.py
```

Repo layout:

```
Uru/
├── main.ts              # plugin entry — lifecycle, commands, status
├── src/
│   ├── bootstrap/uv.ts  # uv-based Python/khora bootstrap + model download
│   ├── sidecar/         # process manager + typed HTTP client
│   ├── indexing/        # full + incremental vault indexing (hash-gated)
│   ├── views/           # recall + chat panels
│   └── settings.ts      # settings tab
└── sidecar/             # Python sidecar (FastAPI + llama.cpp supervisor)
    └── uru_sidecar/
```

</details>

## License

MIT
