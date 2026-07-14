# Uru — Beta Test Plan (for a fresh agent/LLM)

This plan tells a new agent **what to test and how**, focused on the areas that are
**not yet validated**. It is prioritized: P0 = could block any beta user; P1 =
breaks a common path; P2 = quality/edge.

## What you're testing

Uru is an Obsidian plugin (TypeScript) that drives a **local Python sidecar**
(`uru_sidecar`) which runs **two prebuilt llama.cpp `llama-server` binaries**
(chat + embed) behind a one-URL OpenAI proxy, feeding **khora** (embedded
`sqlite_lance`: SQLite + LanceDB). Repo: `github.com/Arsenije/Uru`.

Architecture / entry points:
- Plugin: `main.ts`, `src/sidecar/{manager,client}.ts`, `src/bootstrap/uv.ts`,
  `src/indexing/{indexer,hashStore}.ts`, `src/views/*`, `src/paths.ts`.
- Sidecar: `sidecar/uru_sidecar/{__main__,app,lifecycle,llama,proxy,config,serialize,models}.py`.
- Scriptable tests already exist: `sidecar/scripts/{smoke_sidecar,test_chat,test_bigdoc,test_index}.py`.

### Already validated (don't re-litigate, but regression-check)
- On **macOS arm64**, against **khora 0.21.0 from PyPI** + the llama.cpp `b9838`
  `llama-server` binary: smoke (remember/recall/forget) and chat (vault +
  current-note scope) all pass.

### NOT validated (this is the point of the plan)
1. The **end-to-end bootstrap has never run through Obsidian** — only its pieces
   were tested via shell. The plugin's own uv download, llama.cpp download/extract,
   venv creation, and model download are unexercised.
2. **Windows and Linux** are entirely untested (asset names, `tar -xf`, `taskkill`,
   app-data paths, Gatekeeper-equivalent issues).
3. khora **0.21.0 API drift** beyond `create_namespace` (only the happy path was hit).

---

## P0 — From-scratch install (the #1 gap)

**Goal:** prove a real user with *nothing* preinstalled can install and run Uru.

**Setup (must defeat the dev fast-path):** `src/bootstrap/uv.ts::ensureBackend`
short-circuits if `sidecar/.venv` + `sidecar/.models` + `sidecar/.llamacpp-test`
exist. Test on a machine/user account **without** those, or temporarily rename them.

1. Build + package: `bash scripts/package.sh` → `dist/uru-v<ver>.zip`. Confirm it
   contains only `main.js, manifest.json, styles.css, sidecar/` (no `.venv/.models`).
2. Extract into a throwaway vault's `.obsidian/plugins/uru/`, enable in Obsidian.
3. **Setup modal** appears → Install & start. Watch the progress log.
   - Pass: `uv` downloads; Python 3.13 installs; venv builds; `khora==0.21.0` +
     `uru_sidecar` install **from wheels (no C/C++ compiler invoked)**; the
     llama.cpp binary downloads + extracts + runs; models (~3 GB) download; status
     bar reaches **`Uru ✓`**. No step requires a preinstalled toolchain.
4. Index a few notes; run recall + chat → correct, with clickable citations.
5. **Update simulation:** re-extract a newer zip over the plugin folder, reload →
   the db/index in app-data **survive** (no re-index, no re-download).
6. **`Uru: Delete all Uru data`** → app-data removed; re-run setup reinstalls cleanly.

If you can't run Obsidian, approximate steps 3 by replicating `ensureBackend` in a
Node harness (call `uvAsset()`/`llamaAsset()` for this platform, `download`,
`extract`, then `uv pip install <sidecarDir>` and `sidecar/scripts/smoke_sidecar.py`).

## P0 — Cross-platform (Windows, Linux)

Run the P0 install on **Windows x64** and **Linux x64** (and Win arm64 / mac x64 if
possible). Specifically verify:
- Asset names resolve (`src/bootstrap/uv.ts::uvAsset`/`llamaAsset`) — the real
  release filenames exist for that OS/arch.
- `tar -xf` extracts both `.tar.gz` and `.zip` (Win10+ bsdtar).
- `llama-server` runs (Windows: no missing DLLs; Linux: no missing .so / glibc).
- **Process cleanup:** kill Obsidian/reload, then check no orphaned
  `uru_sidecar` / `llama-server` processes (`taskkill /T` on Win; group-kill POSIX).
  See `src/sidecar/manager.ts::killTree`.

## P0 — khora 0.21.0 API audit (very LLM-suited)

We pinned khora `0.21.0` but only smoke-tested the happy path. **Read the installed
khora 0.21.0 source** (in the venv `site-packages/khora`) and verify every call our
sidecar makes still matches — the smoke path won't catch drift in less-used calls:
- `lifecycle.py`: `Khora(run_migrations=True)`, `connect`, `create_namespace()`,
  `get_namespace_by_stable_id`, `recall(query, namespace=, limit=, min_similarity=)`,
  `remember(content, namespace=, title=, external_id=, metadata=)`,
  `forget(document_id, namespace=)`, `health_check`.
- The **forget-by-external_id** path reaches into internals:
  `kb._engine._storage.get_document_by_external_id(external_id, namespace_id=ns.id)`.
  Confirm `_engine._storage` and that method/signature still exist in 0.21.0 — this
  is the most fragile call. Test `/forget` with only an `external_id` (no doc id).
- `RecallResult` shape used in `serialize.py` (`chunks[].document_id`,
  `documents[].id/.external_id`).

---

## P1 — Functional & regression (scriptable, no Obsidian needed)

Run from `sidecar/` with a venv + the cached binary/models:
- `smoke_sidecar.py` (remember/recall/forget/auth), `test_chat.py` (vault + note
  scope, streaming + non-streaming), `test_bigdoc.py` (big multi-chunk note doesn't
  time out), `test_index.py` (batch path). All should PASS.
- **Incremental indexing** (`src/indexing/indexer.ts`): edit one note → only it
  re-indexes (hash gate); rename → forget+remember; delete → forget. Verify via
  the sidecar/db.
- **Lifecycle robustness:** start two sidecars on the same db (lockfile takeover);
  let the plugin idle > 120s with no heartbeat → sidecar self-exits (idle watchdog
  in `__main__.py`); crash a `llama-server` child → sidecar restarts it.
- **Concurrency/timeout:** confirm LLM calls are serialized (`KHORA_LLM_MAX_CONCURRENT_LLM_CALLS=1`)
  and the 300s timeout holds — a large note must complete, not retry-storm.

## P1 — Security surface

- The control API binds **127.0.0.1 only** and requires a **Bearer token** (random
  per launch) on all routes except `/health`. Confirm another local process can't
  drive `/remember`/`/recall` without the token.
- CORS is allowlisted to `app://obsidian.md` and the unauthenticated `/health`
  no longer carries prompt previews. Sanity-check a drive-by web page can't read
  anything off the local ports (llama + proxy now also require the Bearer token).
- Models/binaries are downloaded over HTTPS from GitHub/HF; note that uv/llama
  downloads are **not SHA-pinned** yet (P2) — flag if this matters for the threat model.

## P2 — Quality & adversarial (LLM is good at this)

- **Diverse corpus:** generate notes that stress indexing — huge notes, empty/
  whitespace, frontmatter-only, heavy code blocks, tables, non-English/unicode,
  emoji, notes that are just links. Confirm no crash and reasonable chunking.
- **Paths with spaces/unicode** in the vault path and note paths (→ `external_id`):
  index + recall + citation-open round-trip must work.
- **Recall quality (LLM-as-judge):** index a known corpus, recall N queries,
  judge precision/relevance of the returned chunks.
- **Embedding-dimension trap:** changing the embed model mid-vault → confirm the
  guardrail/behavior (dimension is baked into LanceDB; mismatch should be caught or
  documented, not silently corrupt).
- **Failure injection:** kill network mid-model-download; fill the disk; remove the
  llama binary between runs — confirm errors are actionable (setup modal "Copy
  diagnostics"), not silent hangs.
- **Code review of the diff** for bugs (run `/code-review` or read the recent
  commits): focus on `src/bootstrap/uv.ts` (download/extract/path logic),
  `src/sidecar/manager.ts` (process lifecycle), `lifecycle.py` (forget internals).

---

## Windows verification round (changes shipped code-reviewed but untested on Windows)

The 2026-07 hardening pass touched several Windows-only paths that no Windows
machine has exercised yet. On the next Windows tester pass, specifically confirm:

- **Stale-lock recovery:** force-quit Obsidian, relaunch — the leftover sidecar
  is taken over WITHOUT killing any unrelated process (PID ownership is now
  verified via `Get-CimInstance` before `taskkill`).
- **Graceful quit:** quit Obsidian mid-index — the sidecar now gets a bounded
  `/shutdown` (khora flush) before `taskkill /F`; check the db opens cleanly after.
- **No UI freeze at startup:** GPU detection (PowerShell/WMI) is now async —
  Obsidian must stay responsive during backend boot, including first setup.
- **Model names** in Settings → Models show basenames, not full `C:\…` paths.
- **llama auth:** `LLAMA_API_KEY` env works on the Windows llama.cpp build
  (unauthenticated request to the llama port → 401), as verified on macOS.

## How to report
For each item: state platform, exact steps, expected vs actual, and attach the
sidecar diagnostics (Settings → Uru → Copy diagnostics, or the `llama-*.log` /
sidecar stderr). File findings as GitHub issues on `Arsenije/Uru` tagged `beta`.
