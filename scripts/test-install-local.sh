#!/usr/bin/env bash
#
# One-liner local end-to-end test of install.sh against the working tree.
#
# What it does:
#   1. Builds the appstrate image from the current source → tag :local
#   2. Aliases the latest published pi/sidecar images → tag :local
#   3. Runs install.sh with assets from ./examples/self-hosting (no GitHub roundtrip)
#   4. Probes http://localhost:$PORT
#   5. Re-runs to verify noop behavior
#   6. Uninstalls + cleans up local image tags
#
# Usage:
#   ./scripts/test-install-local.sh                      # default: port 3999
#   ./scripts/test-install-local.sh --port 8080
#   ./scripts/test-install-local.sh --keep               # don't uninstall at the end
#   ./scripts/test-install-local.sh --no-build           # skip rebuild (reuse :local)
#   ./scripts/test-install-local.sh --runtime-tag X.Y.Z  # which pi/sidecar to alias

set -euo pipefail

PORT=3999
KEEP=0
BUILD=1
RUNTIME_TAG="1.0.0-alpha.45"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)         PORT="$2"; shift ;;
    --keep)         KEEP=1 ;;
    --no-build)     BUILD=0 ;;
    --runtime-tag)  RUNTIME_TAG="$2"; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's|^# \?||'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="local"
WORKDIR="/tmp/appstrate-localtest"

cyan(){ printf "\033[0;36m%s\033[0m\n" "$*"; }
green(){ printf "\033[0;32m%s\033[0m\n" "$*"; }
red(){ printf "\033[0;31m%s\033[0m\n" "$*" >&2; }

cleanup_workdir() {
  if [ -f "$WORKDIR/docker-compose.yml" ]; then
    docker compose -f "$WORKDIR/docker-compose.yml" --env-file "$WORKDIR/.env" down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR" 2>/dev/null || true
}

cd "$REPO_ROOT"

cyan "── 0. Pre-flight"
docker info >/dev/null || { red "Docker daemon not running"; exit 1; }
cleanup_workdir

if [ "$BUILD" -eq 0 ] && ! docker image inspect "ghcr.io/appstrate/appstrate:$TAG" >/dev/null 2>&1; then
  cyan "── 1. --no-build requested but image missing — building anyway"
  BUILD=1
fi
if [ "$BUILD" -eq 1 ]; then
  cyan "── 1. Building ghcr.io/appstrate/appstrate:$TAG (this takes a few minutes)"
  docker build -t "ghcr.io/appstrate/appstrate:$TAG" .
else
  cyan "── 1. Skipping build (image present, --no-build)"
fi

cyan "── 2. Aliasing pi/sidecar runtime images ($RUNTIME_TAG → $TAG)"
for img in appstrate-pi appstrate-sidecar; do
  if ! docker image inspect "ghcr.io/appstrate/$img:$RUNTIME_TAG" >/dev/null 2>&1; then
    docker pull "ghcr.io/appstrate/$img:$RUNTIME_TAG"
  fi
  docker tag "ghcr.io/appstrate/$img:$RUNTIME_TAG" "ghcr.io/appstrate/$img:$TAG"
done

cyan "── 3. Running install.sh with local assets"
RENDERED=$(mktemp)
sed "s|__APPSTRATE_VERSION__|$TAG|g" scripts/install.sh > "$RENDERED"
chmod +x "$RENDERED"

APPSTRATE_DIR="$WORKDIR" \
APPSTRATE_PORT="$PORT" \
APPSTRATE_QUIET=1 \
APPSTRATE_VERSION="$TAG" \
APPSTRATE_ASSETS_DIR="$REPO_ROOT/examples/self-hosting" \
  "$RENDERED"
rm -f "$RENDERED"

cyan "── 4. Probing http://localhost:$PORT (max 30s)"
deadline=$(( $(date +%s) + 30 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS --max-time 3 "http://localhost:$PORT" >/dev/null 2>&1; then
    green "✓ healthy"
    break
  fi
  sleep 2
done
curl -fsS --max-time 3 "http://localhost:$PORT" >/dev/null 2>&1 || {
  red "✗ Not responding after 30s — recent appstrate logs:"
  docker logs appstrate-appstrate-1 --tail 20 2>&1 || true
  exit 1
}

cyan "── 5. Re-running installer (must be noop)"
APPSTRATE_DIR="$WORKDIR" APPSTRATE_PORT="$PORT" APPSTRATE_QUIET=1 \
APPSTRATE_VERSION="$TAG" APPSTRATE_ASSETS_DIR="$REPO_ROOT/examples/self-hosting" \
  bash <(sed "s|__APPSTRATE_VERSION__|$TAG|g" scripts/install.sh) > /tmp/run2.log 2>&1
if grep -q "Already at" /tmp/run2.log; then
  green "✓ noop confirmed"
else
  red "✗ noop check failed"; tail -10 /tmp/run2.log; exit 1
fi

if [ "$KEEP" -eq 1 ]; then
  green "✓ Done — install kept at $WORKDIR (port $PORT)."
  green "  Stop:   docker compose -f $WORKDIR/docker-compose.yml down"
  green "  Purge:  docker compose -f $WORKDIR/docker-compose.yml down -v && rm -rf $WORKDIR"
else
  cyan "── 6. Cleanup"
  cleanup_workdir
  for img in appstrate appstrate-pi appstrate-sidecar; do
    docker rmi "ghcr.io/appstrate/$img:$TAG" >/dev/null 2>&1 || true
  done
  green "✓ All clean"
fi
