#!/usr/bin/env bash
# Reproducibly vendor Intuit's QuickBooks Online MCP server into ./server.
#
# The runner container has no network to the npm registry, so the server is
# bundled to a SINGLE self-contained ESM file (server/index.mjs) with esbuild —
# keeps the .afps under the 10 MB import limit (66 MB node_modules → 3.3 MB).
# Output is gitignored; regenerate with: bash build-server.sh
set -euo pipefail

REPO="https://github.com/intuit/quickbooks-online-mcp-server.git"
REF="${QBO_MCP_REF:-main}"          # pin a tag/sha for reproducibility
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ cloning $REPO@$REF"
git clone --depth 1 --branch "$REF" "$REPO" "$WORK/src" 2>/dev/null \
  || git clone --depth 1 "$REPO" "$WORK/src"

cd "$WORK/src"
echo "→ npm install + build (tsc → dist/)"
npm install --no-audit --no-fund
npm run build

echo "→ bundle to single ESM file (esbuild)"
# createRequire banner: lets the bundled CJS deps (node-quickbooks, intuit-oauth)
# use require() from an ESM output.
npx --yes esbuild@0.24.0 dist/index.js --bundle --platform=node --format=esm \
  --outfile=index.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

echo "→ stage into $HERE/server"
rm -rf "$HERE/server"
mkdir -p "$HERE/server"
cp index.mjs "$HERE/server/index.mjs"

echo "✓ server bundled ($(du -sh "$HERE/server/index.mjs" | cut -f1))"
