#!/usr/bin/env bash
# End-to-end contract for the production platform image and compose topology.
#
# Public seams only:
#   - GET /health from the built image
#   - Docker's health state for that running container
#
# The positive instance uses the real Docker socket and must be healthy. The
# negative instance points the same image at a missing socket; boot completes
# in degraded mode and the image healthcheck must mark the container unhealthy.
#
# HEALTH_E2E_EE=1 boots the SAME image and topology with the commercial module
# enabled and adds one assertion (see "EE module" below). That mode is the
# `ee-container-e2e` job in .github/workflows/test.yml; it replaces the
# release-time `verify` the cloud repo used to run against its own second image.

set -euo pipefail

readonly E2E_IMAGE="${HEALTH_E2E_IMAGE:-appstrate-health-e2e:local}"
readonly E2E_PROJECT="${HEALTH_E2E_PROJECT:-appstrate-health-e2e}"
readonly E2E_PORT="${HEALTH_E2E_PORT:-3317}"
readonly COMPOSE_FILE="test/setup/docker-compose.health-e2e.yml"
readonly E2E_EE="${HEALTH_E2E_EE:-0}"

export HEALTH_E2E_IMAGE="$E2E_IMAGE"
export POSTGRES_USER=e2e
export POSTGRES_PASSWORD=e2e-postgres-password
export MINIO_ROOT_USER=e2e-minio
export MINIO_ROOT_PASSWORD=e2e-minio-password
export BETTER_AUTH_SECRET=e2e-auth-secret-that-is-at-least-32-characters
export CONNECTION_ENCRYPTION_KEY=Y2FzgQmlgIRocYT1VUWM+73fQ5zOTPB8sHJxTh1x4qI=
export UPLOAD_SIGNING_SECRET=e2e-upload-signing-secret
export RUN_TOKEN_SECRET=e2e-run-token-secret
export CONNECT_SESSION_SECRET=e2e-connect-session-secret
export APP_URL="http://127.0.0.1:${E2E_PORT}"
export PORT="$E2E_PORT"

if [ "$E2E_EE" = "1" ]; then
  # Derived from the schema, never restated: pinning the other members here
  # would leave this job booting yesterday's module set the day one is added
  # (#513, one level down — the same reason the compose file pins no MODULES).
  default_modules=$(bun -e '
    import { envSchema } from "./packages/env/src/index.ts";
    console.log(envSchema.shape.MODULES.parse(undefined));
  ')
  export MODULES="${default_modules},@appstrate/module-ee"
  # `Module loaded` and `billing sweeper started` are info-level.
  export HEALTH_E2E_LOG_LEVEL=info
  # The module creates this database itself at boot, via the server's `postgres`
  # maintenance database and these same credentials.
  export EE_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@appstrate-postgres:5432/appstrate_ee"
  # Never called — nothing in this e2e reaches Stripe. They exist because the
  # module's own Zod schema refuses to initialize without them.
  export STRIPE_SECRET_KEY=sk_test_health_e2e
  export STRIPE_WEBHOOK_SECRET=whsec_test_health_e2e
  export STRIPE_PRICE_ID_STARTER=price_test_starter
  export STRIPE_PRICE_ID_PRO=price_test_pro
fi

compose() {
  docker compose \
    --project-name "$E2E_PROJECT" \
    -f docker-compose.yml \
    -f "$COMPOSE_FILE" \
    "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_health_body() {
  local expected="$1"
  local body=""
  for _ in $(seq 1 90); do
    body=$(curl -fsS "http://127.0.0.1:${E2E_PORT}/health" 2>/dev/null || true)
    if jq -e --arg expected "$expected" '.status == $expected' <<<"$body" >/dev/null 2>&1; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for /health status=$expected; last body: $body" >&2
  compose logs --no-color appstrate >&2 || true
  return 1
}

wait_for_docker_health() {
  local container_id="$1"
  local expected="$2"
  local actual=""
  for _ in $(seq 1 120); do
    actual=$(docker inspect "$container_id" --format '{{.State.Health.Status}}')
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for Docker health=$expected; actual=$actual" >&2
  docker inspect "$container_id" --format '{{json .State.Health}}' >&2
  return 1
}

cleanup

if [ "${HEALTH_E2E_SKIP_BUILD:-0}" != "1" ]; then
  docker build \
    --build-arg APP_VERSION=health-container-e2e \
    --build-arg "GIT_SHA=$(git rev-parse HEAD)" \
    -t "$E2E_IMAGE" \
    .
fi

health_config=$(docker image inspect "$E2E_IMAGE" --format '{{json .Config.Healthcheck}}')
bun -e '
  const health = JSON.parse(Bun.argv[1]);
  const command = health.Test?.join(" ") ?? "";
  if (
    !command.includes("/health") ||
    !command.includes("status===\x27healthy\x27") ||
    health.Interval !== 30_000_000_000 ||
    health.Timeout !== 10_000_000_000 ||
    health.StartPeriod !== 15_000_000_000 ||
    health.Retries !== 3
  ) {
    throw new Error("Unexpected image healthcheck: " + JSON.stringify(health));
  }
' "$health_config"

echo "==> Healthy orchestrator"
export HEALTH_E2E_DOCKER_SOCKET=/var/run/docker.sock
compose up -d appstrate
positive_body=$(wait_for_health_body healthy)
jq -e '
  .status == "healthy" and
  .checks.database.status == "healthy" and
  .checks.agents.status == "healthy" and
  .checks.realtime.status == "healthy"
' <<<"$positive_body" >/dev/null
positive_id=$(compose ps -q appstrate)
wait_for_docker_health "$positive_id" healthy
echo "$positive_body" | jq -c '{status, checks}'
echo "docker_health=healthy"

if [ "$E2E_EE" = "1" ]; then
  # A healthy /health says nothing about the module: an image that silently
  # never loaded it is healthy too. Only a loaded, initialized module prints
  # these two lines, and the first must carry the module id on the same line.
  echo "==> EE module"
  positive_logs=$(compose logs --no-color appstrate)
  # Two greps over a variable rather than one pipeline, for the SIGPIPE reason
  # spelled out at the negative-phase grep below.
  module_lines=$(grep -F 'Module loaded' <<<"$positive_logs" || true)
  if ! grep -q '"id":"ee"' <<<"$module_lines"; then
    echo 'No `Module loaded` line with "id":"ee" — the EE module never loaded' >&2
    exit 1
  fi
  if ! grep -q 'billing sweeper started' <<<"$positive_logs"; then
    echo 'EE module loaded but its billing sweeper never started' >&2
    exit 1
  fi
  echo "ee_module=loaded"
fi

compose down --volumes --remove-orphans >/dev/null

echo "==> Unavailable orchestrator"
export HEALTH_E2E_DOCKER_SOCKET=/tmp/appstrate-health-e2e-missing.sock
compose up -d appstrate
negative_body=$(wait_for_health_body degraded)
jq -e '
  .status == "degraded" and
  .checks.database.status == "healthy" and
  .checks.agents.status == "degraded"
' <<<"$negative_body" >/dev/null
negative_id=$(compose ps -q appstrate)

# Docker runs health probes every five seconds during start-period. The old
# compose-level `wget /` override therefore turned healthy almost immediately,
# even while the public health contract said degraded. Fail fast on that exact
# regression before waiting for the image's three post-start failures.
sleep 7
early_health=$(docker inspect "$negative_id" --format '{{.State.Health.Status}}')
if [ "$early_health" = "healthy" ]; then
  echo "Docker reported healthy while GET /health reported degraded" >&2
  docker inspect "$negative_id" --format '{{json .Config.Healthcheck}}' >&2
  exit 1
fi

wait_for_docker_health "$negative_id" unhealthy
# Read the log into a variable first, then match. Piping straight into `grep -q`
# makes the pipeline's exit status a race: grep leaves on its first match, and
# under `pipefail` the SIGPIPE that kills `docker compose logs` mid-write fails
# the whole script. Invisible while the container logged at `warn` (too little
# output to still be writing), fatal the moment EE mode raised it to `info`.
negative_logs=$(compose logs --no-color appstrate)
grep -q 'Could not initialize container orchestrator' <<<"$negative_logs"
echo "$negative_body" | jq -c '{status, checks}'
echo "docker_health=unhealthy"

echo "Platform container health E2E passed"
