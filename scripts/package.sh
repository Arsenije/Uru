#!/usr/bin/env bash
# Build a manual-install zip: main.js + manifest.json + styles.css + the
# bundled Python sidecar source (uru_sidecar + pyproject). Models/venv/binaries
# are downloaded by the plugin on first run, never bundled.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

VER=$(node -p "require('./manifest.json').version")
OUT="dist/uru"
rm -rf dist
mkdir -p "$OUT/sidecar/uru_sidecar"
cp main.js manifest.json styles.css "$OUT/"
cp scripts/verify-staging.mjs "$OUT/"
cp sidecar/pyproject.toml "$OUT/sidecar/"
cp sidecar/uru_sidecar/*.py "$OUT/sidecar/uru_sidecar/"

( cd dist && zip -rq "uru-v$VER.zip" uru )
echo "built dist/uru-v$VER.zip"
unzip -l "dist/uru-v$VER.zip"
