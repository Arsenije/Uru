# Changelog

All notable changes to Uru are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
