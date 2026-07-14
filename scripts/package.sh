#!/usr/bin/env bash
# Build a manual-install zip: main.js (which carries the embedded Python
# sidecar — see scripts/sidecar-embed.mjs) + manifest.json + styles.css.
# Models/venv/binaries are downloaded by the plugin on first run, never bundled.
# Zip name matches the release workflow: uru-<version>.zip, no "v" prefix
# (Obsidian requires un-prefixed release tags).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

VER=$(node -p "require('./manifest.json').version")
OUT="dist/uru"
rm -rf dist
mkdir -p "$OUT"
cp main.js manifest.json styles.css "$OUT/"
cp scripts/verify-staging.mjs "$OUT/"

( cd dist && zip -rq "uru-$VER.zip" uru )
echo "built dist/uru-$VER.zip"
unzip -l "dist/uru-$VER.zip"
