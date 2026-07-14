# Changelog

All notable changes to Uru are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] — 2026-07-14

### Changed
- **Ready for Obsidian's community plugin directory.** The Python sidecar now travels *inside* `main.js` (embedded at build time) instead of shipping as a separate `sidecar/` folder — so an install that receives only `main.js`, `manifest.json`, and `styles.css` (exactly what Obsidian's community-directory installer downloads) bootstraps correctly. First-run setup writes the embedded source into Uru's app-data folder and installs it from there; nothing changes for already-set-up vaults.
- **Release mechanics match Obsidian's requirements.** Releases are now tagged with the bare version (`0.1.11`, not `v0.1.11`) to match `manifest.json` exactly, and `main.js`, `manifest.json`, and `styles.css` are attached to each release as individual assets (the community installer fetches those files directly). The manual-install zip remains, renamed to `uru-<version>.zip` and no longer containing a `sidecar/` folder.
- **Manifest polish for review.** `minAppVersion` raised from the sample-plugin template's `0.15.0` to `1.5.0`, the description now leads with what Uru does ("Search and chat with your vault…"), and `authorUrl` points at the author's GitHub profile.

### Added
- **LICENSE file** (MIT) at the repo root — the README and package metadata already said MIT; now GitHub and Obsidian's review tooling can see it too.
- **"Network use" section in the README** — a table of exactly what the first-run setup downloads, from which hosts, and why; every item version- or revision-pinned. After setup, the plugin only talks to its own sidecar on `127.0.0.1`.
- **Submission notes for Obsidian reviewers** (`docs/obsidian-submission.md`) — why Uru exists, the technical decisions behind the first-run backend bootstrap, and a policy-compliance checklist.

### Fixed
- **`versions.json` no longer overpromises compatibility.** Every row claimed `minAppVersion` `0.15.0` (the sample-plugin template default); all rows now say `1.5.0`, matching the manifest.

## [0.1.10] — 2026-07-14

### Changed
- **One consistent voice across every label, notice, and error.** The search feature is now called **Search** everywhere (ribbon, command, and panel — previously "Recall"); user-facing messages say **"the local AI service"** instead of the internal word "backend"; and status-bar tooltips show plain words ("Ready", "Starting…") instead of raw internal state. Notices drop the inconsistent "Uru:" prefix, use consistent punctuation, and no longer duplicate the same message two ways. "Remove Uru completely" is now **"Uninstall Uru"**, the indexing button reads **"Index new & edited"**, and the underlying library is capitalized as **Khora**. Developer-only details (raw relevance scores, all-caps `ERROR:`, "(no answer)") no longer leak into the UI. No behavior changed — only wording.
- **A clearer, better-organized Settings page.** The Status row is now labelled **"Uru setup"** and its button reads **"Repair Uru"** (was "Re-run setup"). **"Index on startup"** moved up next to the indexing controls it affects, out of the Advanced section. The Models section now links each model to a short **"Why this model?"** explainer in the README, and the **"Uninstall Uru"** description leads with what to do and reads more plainly.

### Removed
- **Deep indexing (entity extraction) is gone.** Uru no longer runs a local model over every note to map people, places, and ideas — indexing is now always the fast embeddings-only path (what used to be called "Quick"). The Deep/Quick choice disappears from the chat first-run prompt and Settings, the "People & topics" chips disappear from Search, and indexing a large vault drops from hours to minutes. Search, chat, and citations are unchanged. Notes indexed under Deep mode keep working as-is; no re-index is needed.
- **"Link notes in the graph" is gone.** The Settings section that wrote a "uru-links" property into your notes' frontmatter (so connections showed in Obsidian's Graph view) has been removed. On the first launch after updating, Uru automatically strips the "uru-links" property from any notes that still carry it — the same clean undo the "Remove Uru links" button performed — and tells you how many notes were cleaned. Your note text and other properties are untouched.
- **"Reset this vault's Uru data" is gone.** The Danger-zone button that cleared just this vault's index while keeping the shared AI service has been removed — it overlapped confusingly with "Uninstall Uru". To rebuild a vault's index, use **"Re-index everything"**; to remove everything, use **"Uninstall Uru"**.

### Fixed
- **No more stray console windows on Windows.** Each local AI server (chat + embedding, and a fresh one on every crash-restart) used to pop up its own `cmd` window because it inherited no console from the backend. The servers now launch with `CREATE_NO_WINDOW`, and first-run setup steps (uv, Python, GPU detection) no longer flash a console either. Windows only — macOS and Linux were never affected.
- **A crashing backend no longer piles up llama.cpp processes on Windows either.** The Windows backend now runs its llama.cpp servers inside a kill-on-close Job Object, so they shut down with the backend no matter how it dies (matching the Linux behavior added in 0.1.9). Previously a hard crash could leave llama.cpp servers resident and stack more on each restart.
- **Settings no longer gets stuck on "Setting up…".** While the local AI service was booting, the Settings status row could stay on "Setting up…" until you closed and reopened Settings — even though Uru was already ready. It now updates live to "Ready" the moment the service is up.

## [0.1.9] — 2026-07-09

### Added
- **Automatic GPU acceleration on Windows and Linux.** On first run Uru now detects a supported GPU (AMD, Nvidia, or Intel) and downloads a Vulkan build of llama.cpp instead of the CPU-only build, so chat and indexing run on the GPU — a large speedup, especially for Deep mode. It falls back to the CPU build automatically if no usable GPU is found (and remembers that so it doesn't re-download each launch). Existing installs are upgraded to the GPU build on the next launch when a GPU is present. macOS is unchanged (it already uses the Metal GPU).

### Fixed
- **Linux setup no longer downloads ~6 GB of unused NVIDIA CUDA libraries.** The backend install now always picks the CPU build of PyTorch — Uru only carries PyTorch as an indirect dependency and never runs it (all AI inference happens in llama.cpp), but on Linux the default download was the CUDA build plus 21 NVIDIA packages. First-run setup on Linux is now several GB smaller and minutes faster.
- **A crashing backend no longer piles up llama.cpp processes.** If the backend process died unexpectedly (e.g. killed by the OS when memory ran out), its two llama.cpp servers were left running, and every automatic restart added two more — eating memory until startup could no longer succeed. On Linux the llama.cpp servers now shut down with the backend no matter how it dies.
- **The backend was reinstalled on every launch** due to a version-pin mismatch (the plugin expected sidecar 0.2.10 while the bundled code reported 0.2.9). The versions are back in sync, so a healthy install is reused.
- **Crash diagnostics now record how the backend exited** (exit code and signal), so a silent native crash or out-of-memory kill shows up in the diagnostics log instead of the log just stopping mid-startup.

## [0.1.8] — 2026-07-03

### Added
- **Loading state while Uru starts.** Opening Chat or Recall before the local backend is ready now shows a clear "Starting Uru…" state (with a live progress indicator) instead of a dead or misleading input box, and switches to the real chat/search view automatically once the backend is up. If startup fails, both panels show a plain error with a **Retry** button.

### Changed
- **Simpler first-run setup.** The setup dialog leads with a shorter, privacy-focused intro and no longer asks you to choose Quick vs Deep up front — it defaults to Deep, still changeable anytime in Settings. The install button now spells out that it "can take a few minutes," and the final log line reads "Setup complete — backend ready."

## [0.1.7] — 2026-07-03

### Added
- **"Danger zone" in Settings** with two scoped cleanup actions — "Reset this vault's Uru data" and "Remove Uru completely" — backed by a small `vaults.json` registry, so cleanup never deletes another vault's index or a shared backend it still needs. This makes it easy to fully clean up (models, Python environment, index) before removing the plugin, since Obsidian's own uninstall only removes the in-vault plugin folder.

### Changed
- **Consistent plain-language copy across every surface.** Removed the remaining "knowledge graph" / "Lite" / "Full" wording (which clashed with Obsidian's graph view) in favor of the **Quick / Deep** vocabulary and a "maps how your notes connect" framing — in the Recall command, the manifest description, and the README. Softened "backend" out of user-facing error notices (power-user command names stay as-is). Renamed the Recall panel's "Entities" heading to "People & topics".

### Removed
- The command-palette-only "Delete all Uru data" command, which wiped every vault's data unconditionally — replaced by the scoped Danger zone actions above.

### Fixed
- A failed first-run setup (e.g. the local AI service didn't start, so no note was indexed) no longer shows a misleading "Indexing didn't finish — Resume" prompt; it now offers a clean retry.

## [0.1.6] — 2026-07-01

### Added
- **`CHANGELOG.md`** — a dedicated, backfilled release history (0.1.0–0.1.5), replacing the inline README section.

### Changed
- **GitHub release notes are now generated from this changelog.** The release workflow reads the matching version section from `CHANGELOG.md` (falling back to the manual-install instructions), so each release documents what actually changed instead of repeating boilerplate.

## [0.1.5] — 2026-07-01

### Changed
- **Sleep-safe, crash-resilient indexing.** Indexing now **resumes** where it left off after an interruption instead of restarting from zero (only a corrupted state file forces a fresh run), and the backend sidecar **survives OS sleep** rather than being killed by the idle watchdog mid-sleep.

### Added
- **Estimated time remaining (ETA)** while indexing.
- **Resume indexing** prompt (chat first-run) and command, shown when a previous run was interrupted.

### Performance
- Reuse a single shared entity extractor per model across documents (VectorCypher extraction state), preserving concurrency/circuit-breaker state instead of rebuilding it per note — faster, steadier Deep indexing.

## [0.1.4] — 2026-07-01

### Added
- **Deep vs Quick choice in the chat first-run prompt.** Opening chat before the vault is indexed now lets you pick indexing depth up front, with the same explanation as the setup dialog.

## [0.1.3] — 2026-07-01

### Changed
- **Unified, plain-language copy** across the setup dialog, chat, and settings. "Lite/Full" became **Quick/Deep**, and the "knowledge graph" wording (which clashed with Obsidian's own graph view) was replaced with plain descriptions of what Deep indexing does.
- **Restructured settings**: merged the indexing sections, moved power-user options and model details behind collapsible groups, added friendly model names, and replaced the raw namespace UUID on the status row with a plain-language status.

### Added
- **First-run "Index my vault" prompt in the chat panel** when the vault isn't indexed yet, with a live progress bar.
- **Live re-index progress bar** in settings.

## [0.1.2] — 2026-07-01

### Fixed
- **Bootstrap downloads now work in the Obsidian renderer.** Switched to Obsidian's `requestUrl`; the previous `fetch()` was CORS-blocked on GitHub release-asset redirects, breaking the first-run download.

### Added
- One-command source install (`npm run install-plugin`).

### Docs
- Warn against installing "Source code (zip)" — it lacks the built `main.js` and won't load.

## [0.1.1] — 2026-06-29

### Fixed
- **Beta-readiness hardening**: a repairable bootstrap that self-heals a partial install, `llama-server` crash supervision with a truthful status badge, automatic Lite↔Full re-extraction, and revision-pinned model downloads.

### Added
- Headless staging verification for assistant-led installs.

### Docs
- README rewrite with an assistant-friendly install path.

## [0.1.0] — 2026-06-29

### Added
- First public beta: local knowledge-graph + semantic search and RAG chat for Obsidian, fully offline.

[Unreleased]: https://github.com/Arsenije/Uru/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/Arsenije/Uru/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Arsenije/Uru/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Arsenije/Uru/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Arsenije/Uru/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Arsenije/Uru/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Arsenije/Uru/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Arsenije/Uru/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Arsenije/Uru/releases/tag/v0.1.0
