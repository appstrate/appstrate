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
#   6. APP_URL drift → OIDC redirect-URI reconciliation (regression for #145)
#   7. Uninstalls + cleans up local image tags
#
# Usage:
#   ./scripts/test-install-local.sh                      # default: port 3999
#   ./scripts/test-install-local.sh --port 8080
#   ./scripts/test-install-local.sh --keep               # don't uninstall at the end
#   ./scripts/test-install-local.sh --no-build           # skip rebuild (reuse :local)
#   ./scripts/test-install-local.sh --runtime-tag X.Y.Z  # which pi/sidecar to alias
#   DRIFT_PORT=4500 ./scripts/test-install-local.sh      # override drift port (default: PORT+1)

set -euo pipefail

PORT=3999
KEEP=0
BUILD=1
RUNTIME_TAG="${APPSTRATE_RUNTIME_TAG:-latest}"
DRIFT_PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      PORT="$2"
      shift
      ;;
    --keep) KEEP=1 ;;
    --no-build) BUILD=0 ;;
    --runtime-tag)
      RUNTIME_TAG="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="local"
WORKDIR="/tmp/appstrate-localtest"
# Second port used to exercise the APP_URL drift / OIDC reconciliation step.
# Defaults to PORT+1; user can override via env if that port is busy.
DRIFT_PORT="${DRIFT_PORT:-$((PORT + 1))}"

cyan() { printf "\033[0;36m%s\033[0m\n" "$*"; }
green() { printf "\033[0;32m%s\033[0m\n" "$*"; }
red() { printf "\033[0;31m%s\033[0m\n" "$*" >&2; }

cleanup_workdir() {
  if [ -f "$WORKDIR/docker-compose.yml" ]; then
    docker compose -f "$WORKDIR/docker-compose.yml" --env-file "$WORKDIR/.env" down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR" 2>/dev/null || true
}

cd "$REPO_ROOT"

cyan "── 0. Pre-flight"
docker info >/dev/null || {
  red "Docker daemon not running"
  exit 1
}
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
sed "s|__APPSTRATE_VERSION__|$TAG|g" scripts/install.sh >"$RENDERED"
chmod +x "$RENDERED"

APPSTRATE_DIR="$WORKDIR" \
  APPSTRATE_PORT="$PORT" \
  APPSTRATE_QUIET=1 \
  APPSTRATE_VERSION="$TAG" \
  APPSTRATE_ASSETS_DIR="$REPO_ROOT/examples/self-hosting" \
  "$RENDERED"
rm -f "$RENDERED"

cyan "── 4. Probing http://localhost:$PORT (max 30s)"
deadline=$(($(date +%s) + 30))
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
  bash <(sed "s|__APPSTRATE_VERSION__|$TAG|g" scripts/install.sh) >/tmp/run2.log 2>&1
if grep -q "Already at" /tmp/run2.log; then
  green "✓ noop confirmed"
else
  red "✗ noop check failed"
  tail -10 /tmp/run2.log
  exit 1
fi

# ── 6. APP_URL drift → OIDC redirect-URI reconciliation (regression for #145)
#
# Exercises the install-script flow for the operator scenario fixed in PR #157:
# operator changes APP_URL after first boot (port move, custom domain, …),
# expects the platform OIDC client's `redirect_uris` to be reconciled in place
# (same client_id, no DB wipe required).
#
# Steps:
#   a. Snapshot the original instance-client row from `oauth_clients`.
#   b. Verify URIs match the originally-installed APP_URL.
#   c. Edit .env (APP_URL / TRUSTED_ORIGINS / PORT all → DRIFT_PORT).
#   d. Re-run install.sh on DRIFT_PORT — compose recreates the platform
#      container with the new port mapping, ensureInstanceClient() reconciles.
#   e. Verify the row's URIs now match DRIFT_PORT and client_id is preserved.
#   f. Verify the reconcile log line was emitted.
cyan "── 6. APP_URL drift → OIDC redirect-URI reconciliation"

pg_query() {
  # tuples-only, unaligned, no row count — single value out
  docker exec -i appstrate-postgres-1 \
    psql -U appstrate -d appstrate -tA -c "$1"
}

instance_client_row() {
  pg_query "SELECT client_id || '|' || array_to_string(redirect_uris, ',') || '|' || array_to_string(post_logout_redirect_uris, ',') FROM oauth_clients WHERE level='instance' ORDER BY created_at ASC LIMIT 1;"
}

before=$(instance_client_row)
if [ -z "$before" ]; then
  red "✗ no instance-level oauth_clients row found after fresh install"
  exit 1
fi
before_client_id=$(printf '%s' "$before" | cut -d'|' -f1)
before_redirect=$(printf '%s' "$before" | cut -d'|' -f2)
before_post_logout=$(printf '%s' "$before" | cut -d'|' -f3)
green "  before: client_id=$before_client_id redirect_uris=$before_redirect"

want_before="http://localhost:$PORT/auth/callback"
if [ "$before_redirect" != "$want_before" ]; then
  red "✗ unexpected initial redirect_uris: got '$before_redirect', want '$want_before'"
  exit 1
fi
want_before_post="http://localhost:$PORT,http://localhost:$PORT/login"
if [ "$before_post_logout" != "$want_before_post" ]; then
  red "✗ unexpected initial post_logout_redirect_uris: got '$before_post_logout', want '$want_before_post'"
  exit 1
fi

cyan "── 6a. Editing .env: APP_URL/TRUSTED_ORIGINS/PORT → $DRIFT_PORT"
# Use awk for cross-platform in-place edit (BSD vs GNU sed differences).
awk -v from="$PORT" -v to="$DRIFT_PORT" '
  /^APP_URL=/         { sub(":" from, ":" to); print; next }
  /^TRUSTED_ORIGINS=/ { sub(":" from, ":" to); print; next }
  /^PORT=/            { print "PORT=" to; next }
  { print }
' "$WORKDIR/.env" >"$WORKDIR/.env.new"
mv "$WORKDIR/.env.new" "$WORKDIR/.env"
chmod 600 "$WORKDIR/.env"

cyan "── 6b. Re-running installer on port $DRIFT_PORT (compose recreates container)"
RENDERED2=$(mktemp)
sed "s|__APPSTRATE_VERSION__|$TAG|g" scripts/install.sh >"$RENDERED2"
chmod +x "$RENDERED2"
APPSTRATE_DIR="$WORKDIR" APPSTRATE_PORT="$DRIFT_PORT" APPSTRATE_QUIET=1 \
  APPSTRATE_VERSION="$TAG" APPSTRATE_ASSETS_DIR="$REPO_ROOT/examples/self-hosting" \
  "$RENDERED2" >/tmp/run3.log 2>&1 || {
  red "✗ install.sh failed on drift port $DRIFT_PORT — log tail:"
  tail -30 /tmp/run3.log
  exit 1
}
rm -f "$RENDERED2"

cyan "── 6c. Probing http://localhost:$DRIFT_PORT (max 30s)"
deadline=$(($(date +%s) + 30))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS --max-time 3 "http://localhost:$DRIFT_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 3 "http://localhost:$DRIFT_PORT" >/dev/null 2>&1 || {
  red "✗ Not responding on $DRIFT_PORT after 30s — recent appstrate logs:"
  docker logs appstrate-appstrate-1 --tail 30 2>&1 || true
  exit 1
}

cyan "── 6d. Verifying oauth_clients row was reconciled"
after=$(instance_client_row)
after_client_id=$(printf '%s' "$after" | cut -d'|' -f1)
after_redirect=$(printf '%s' "$after" | cut -d'|' -f2)
after_post_logout=$(printf '%s' "$after" | cut -d'|' -f3)
green "  after:  client_id=$after_client_id redirect_uris=$after_redirect"

want_after="http://localhost:$DRIFT_PORT/auth/callback"
want_after_post="http://localhost:$DRIFT_PORT,http://localhost:$DRIFT_PORT/login"
if [ "$after_client_id" != "$before_client_id" ]; then
  red "✗ client_id changed after reconciliation (was '$before_client_id', now '$after_client_id') — outstanding tokens would be invalidated"
  exit 1
fi
if [ "$after_redirect" != "$want_after" ]; then
  red "✗ redirect_uris not reconciled: got '$after_redirect', want '$want_after'"
  exit 1
fi
if [ "$after_post_logout" != "$want_after_post" ]; then
  red "✗ post_logout_redirect_uris not reconciled: got '$after_post_logout', want '$want_after_post'"
  exit 1
fi
green "✓ redirect_uris + post_logout_redirect_uris reconciled, client_id preserved"

cyan "── 6e. Checking platform logs for reconcile warn line"
# Pino's worker transport flushes stdout asynchronously — the reconcile warn
# is emitted during oidcModule.init() but may land in `docker logs` a few
# hundred ms after the HTTP listener becomes healthy. Poll with a deadline
# rather than fail on the first miss. Snapshot to a file each iteration so a
# failure message can show what was actually visible at the time of grep.
deadline=$(($(date +%s) + 15))
found=0
snap=/tmp/appstrate-localtest-platform-logs.txt
while [ "$(date +%s)" -lt "$deadline" ]; do
  docker logs appstrate-appstrate-1 >"$snap" 2>&1 || true
  if grep -q "OIDC platform client redirect URIs updated to match APP_URL" "$snap"; then
    found=1
    break
  fi
  sleep 1
done
if [ "$found" -eq 1 ]; then
  green "✓ reconcile log line emitted"
else
  red "✗ expected 'OIDC platform client redirect URIs updated to match APP_URL' log line not found within 15s"
  red "  (snapshot has $(wc -l <"$snap") lines, OIDC matches: $(grep -c "OIDC" "$snap" || true))"
  red "  (recent platform logs follow)"
  tail -40 "$snap" || true
  exit 1
fi

if [ "$KEEP" -eq 1 ]; then
  green "✓ Done — install kept at $WORKDIR (port $DRIFT_PORT)."
  green "  Stop:   docker compose -f $WORKDIR/docker-compose.yml down"
  green "  Purge:  docker compose -f $WORKDIR/docker-compose.yml down -v && rm -rf $WORKDIR"
else
  cyan "── 7. Cleanup"
  cleanup_workdir
  for img in appstrate appstrate-pi appstrate-sidecar; do
    docker rmi "ghcr.io/appstrate/$img:$TAG" >/dev/null 2>&1 || true
  done
  green "✓ All clean"
fi
