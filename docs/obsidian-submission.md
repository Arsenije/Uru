# Submission notes for Obsidian reviewers

This document explains what Uru is, why it exists, and the technical decisions
behind the parts of it that are unusual for an Obsidian plugin — in particular
the local backend it bootstraps on first run. It's written for whoever reviews
the community-directory submission; nothing here is marketing.

## Why we built this

Uru gives a vault **semantic memory**: search that works by meaning rather than
keywords, and a chat panel that answers questions from your own notes with
`[1]`-style citations back to them. Ask "what did I decide about the pricing
model last spring?" and get the answer with links to the notes it came from.

Two convictions shaped it:

1. **Local-first is non-negotiable.** People keep journals, therapy notes,
   contracts, and unreleased work in their vaults. A retrieval/chat feature that
   uploads notes to a cloud API — even a well-behaved one — changes what the
   vault is. So Uru runs everything on the user's machine: embedding, indexing,
   retrieval, and chat inference all happen locally through llama.cpp. No
   account, no API key, no note ever leaves the computer.

2. **Memory, not decoration.** There are many plugins that visualize note
   connections. Uru isn't one of them — it doesn't draw graphs, doesn't write
   link properties into notes (an early experiment did; we removed it and the
   plugin cleans up after it), and doesn't modify notes at all. The product is
   recall: you type a question, you get your own knowledge back.

The privacy conviction is what makes the engineering unusual. Real local AI
means real local infrastructure — a model runtime, an embedding index, a
retrieval pipeline — and none of that can live inside a browser-context
JavaScript bundle. Everything below follows from that constraint.

## The unusual part: a first-run backend bootstrap

On first run — and only after the user clicks **Install & start** in a consent
dialog that states the download size — Uru sets up a local backend (~3 GB) in
per-user app-data:

- **uv** (version-pinned), from astral-sh/uv GitHub releases — `src/bootstrap/uv.ts`
- **Python 3.13** (python-build-standalone, fetched by uv)
- **Khora + the sidecar package** (exact `==` pins), from PyPI
- **llama.cpp `llama-server`** (build-pinned), from ggml-org/llama.cpp GitHub releases
- **Two GGUF models** (revision-pinned by commit hash), from Hugging Face:
  Qwen2.5-3B-Instruct for chat, bge-m3 for embeddings

Why not bundle it? The backend is gigabytes of platform-specific binaries and
weights; a plugin release can't carry it, and shouldn't — the directory
installer fetches exactly `main.js`, `manifest.json`, and `styles.css`.
Why not ask users to install Python/Ollama themselves? Our audience is people
who take notes, not people who manage Python environments. The bootstrap is the
difference between a tool and a science project.

What keeps this honest:

- **Consent first.** Enabling the plugin downloads nothing. The setup modal
  (`src/views/setupModal.ts`) asks before the first byte moves.
- **Everything is pinned.** uv version, khora version (injected at build time
  from `sidecar/pyproject.toml` via `scripts/khora-pin.mjs`, so the constant
  can't drift from what pip installs), llama.cpp build tag, and both model
  revisions (commit hashes). There is no auto-update channel: components change
  only when a new plugin release changes the pins, and plugin releases go
  through Obsidian's normal update flow.
- **Full disclosure.** The README's [Network use](../README.md#network-use)
  section lists every host contacted and why; the
  [Privacy](../README.md#privacy) section gives the per-OS data locations.

After setup, the plugin's only network traffic is HTTP to its own sidecar on
`127.0.0.1` (authenticated with a per-install token). No telemetry, no
analytics, nothing phones home.

## Technical decisions, and why

**A Python sidecar process instead of in-plugin JavaScript.**
The retrieval pipeline (chunking, embedding, vector + keyword search, reranking,
RAG assembly) is [Khora](https://github.com/DeytaHQ/khora), an Apache-2.0
Python library by the same author. Inference runs through llama.cpp's
`llama-server`. Neither workload is realistic inside Obsidian's renderer — and
keeping it out of the renderer means indexing a 10,000-note vault never blocks
the UI. The plugin spawns and supervises the sidecar (`src/sidecar/manager.ts`:
health checks, crash restart, lockfile so two windows can't double-spawn,
graceful shutdown with a force-kill fallback) and talks to it through a typed
HTTP client (`src/sidecar/client.ts`).

**`isDesktopOnly: true`, honestly.**
The plugin uses `fs`, `path`, `os`, `crypto`, and `child_process`. Local
inference can't run on mobile, so this isn't a limitation we're working around
— it's the design. `onload` also guards with `Platform.isMobile` and explains
why, in case the flag is ever bypassed.

**The Python sidecar source rides inside `main.js` — this is packaging, not
obfuscation.**
Directory installs receive only three files, so a `sidecar/` folder shipped
next to `main.js` would never reach users. Instead, esbuild embeds
`sidecar/pyproject.toml` and every `sidecar/uru_sidecar/*.py` into `main.js` as
a plain-text virtual module (`scripts/sidecar-embed.mjs`); first-run setup
writes those files back out to app-data and pip-installs them from there. The
embedded source is byte-identical to the `sidecar/` directory in this repo —
readable in the shipped `main.js` with a text editor.

**Backend data lives outside the vault, in per-user app-data.**
Models and the Python environment are gigabytes and shared across vaults;
inside the vault they'd be synced by Obsidian Sync, backed up by git users, and
deleted on plugin update. Locations per OS are documented in the README. A
`vaults.json` registry (`src/vaultRegistry.ts`) tracks which vaults share the
backend, so the in-app **Uninstall Uru** flow removes only what's safe — it
refuses to delete the shared runtime while another vault still uses it. The
README also documents manual cleanup for users who removed the plugin first.

**`requestUrl` for every remote download; `fetch` only for localhost streaming.**
All GitHub/Hugging Face downloads go through Obsidian's `requestUrl`
(renderer `fetch` breaks on GitHub's CORS-less release-asset redirects — noted
in `src/bootstrap/uv.ts`). The one `fetch` call in the codebase
(`src/sidecar/client.ts`, `chatStream`) streams chat tokens from
`127.0.0.1`, which `requestUrl` can't do — it has no streaming body. A
non-streaming `chatSync` fallback exists and is used if streaming fails.

**Small models, chosen by measurement.**
Chat runs Qwen2.5-3B (Q4_K_M): a 5-model bake-off against 7B/8B alternatives
found the 3B as reliable for vault-grounded answers at 3–4× the speed, which is
what makes local chat feel usable rather than aspirational. Embeddings use
bge-m3 (8192-token context). Model choices and the reasoning are documented in
the README's "Why this model?" sections.

**Notes are read, never written.**
Indexing hashes note content (`src/indexing/`) and sends changed notes to the
sidecar; nothing writes into user Markdown. The single exception is one-time
*removal* of the `uru-links` frontmatter property that a pre-release experiment
added — cleanup of our own residue, reported to the user with a notice.

## Repo layout note

The repo contains more than the plugin, so review scope is worth clarifying:

- **The plugin** is `main.ts`, `src/`, `styles.css`, `manifest.json`, plus
  `sidecar/` (the Python package embedded into `main.js` at build time).
- **`khora/`** is the source of the Khora backend library (same author,
  Apache-2.0, published to PyPI). The plugin does **not** build or ship from
  this directory — the bootstrap installs the pinned release from PyPI. It's
  co-located for development; treat it as a vendored dependency's source,
  available for inspection.
- `scripts/`, `tests/`, and `docs/` are build tooling, plugin tests, and
  documentation.

## Policy checklist

| Policy | Where we stand |
|---|---|
| Network use disclosed | README → [Network use](../README.md#network-use): every host, every purpose |
| Files outside the vault disclosed | README → [Privacy](../README.md#privacy): per-OS paths, uninstall flow, manual cleanup |
| Telemetry | None, client- or server-side |
| Accounts / payment | None — no account, no API key, nothing paid |
| Ads | None |
| Auto-updating code | None — all components version/revision-pinned to the plugin release |
| Obfuscation | None — embedded sidecar source is plain text, identical to `sidecar/` in this repo |
| Copyright | Plugin is MIT; Khora is Apache-2.0 (same author); models keep their upstream licenses (linked in README) |

## Trying it

A machine with ~8 GB RAM and ~5 GB free disk is enough. On macOS this needs
Apple Silicon and macOS 13.3+ — Intel Macs are unsupported because Uru's
vector database (LanceDB) no longer ships Intel-Mac builds, and older macOS
lacks the Accelerate BLAS routines llama.cpp's release binaries link against;
Windows and Linux work on CPU or a supported GPU. Install, enable, click **Install & start**,
wait out the one-time download, then run **Index vault** and try the search and
chat panels. The status bar shows backend state throughout, and Settings →
Status has a "Copy diagnostics" button if anything looks wrong.
