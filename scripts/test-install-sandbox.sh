#!/usr/bin/env bash
#
# Run install.sh against a clean Ubuntu container.
#
# Two modes:
#   --shared     mount host docker socket (fast, pollutes host with appstrate_* containers)
#   --dind       full Docker-in-Docker (slow, isolated, requires --privileged)
#
# Defaults: --shared, version="main", port 3999.

set -euo pipefail

MODE="shared"
VERSION="main"
PORT=3999
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/install.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --shared)  MODE=shared ;;
    --dind)    MODE=dind ;;
    --version) VERSION="$2"; shift ;;
    --port)    PORT="$2"; shift ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's|^# \?||'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

[ -f "$SCRIPT_PATH" ] || { echo "install.sh not found at $SCRIPT_PATH" >&2; exit 1; }

# Validate version format — $VERSION is interpolated into sed replacement strings
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._]+)?$ ]] &&
  [[ "$VERSION" != "main" ]] &&
  [[ "$VERSION" != "local" ]] &&
  [[ "$VERSION" != "latest" ]]; then
  echo "Invalid version format: $VERSION" >&2
  echo "Expected: vMAJOR.MINOR.PATCH[-prerelease], 'main', 'local', or 'latest'" >&2
  exit 1
fi

echo "→ Sandbox mode: $MODE | version=$VERSION | port=$PORT"

case "$MODE" in
  shared)
    docker run --rm -it \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$SCRIPT_PATH:/install.sh:ro" \
      -e APPSTRATE_PORT="$PORT" \
      -e APPSTRATE_DIR=/root/.appstrate \
      ubuntu:24.04 \
      bash -c "
        set -e
        apt-get update -qq
        apt-get install -qq -y curl ca-certificates docker.io openssl >/dev/null
        sed 's|__APPSTRATE_VERSION__|$VERSION|g' /install.sh > /tmp/i.sh
        chmod +x /tmp/i.sh
        /tmp/i.sh
        echo
        echo '→ Health check:'
        curl -fsS --max-time 5 http://localhost:$PORT >/dev/null && echo '  ✓ responding'
        echo
        echo '→ Re-run (must be noop):'
        /tmp/i.sh
        echo
        echo 'Sandbox done. Cleanup with:'
        echo '  docker compose -f /root/.appstrate/docker-compose.yml down -v'
      "
    ;;

  dind)
    docker run --rm -it --privileged \
      -v "$SCRIPT_PATH:/install.sh:ro" \
      -e APPSTRATE_PORT="$PORT" \
      docker:27-dind \
      sh -c "
        set -e
        dockerd-entrypoint.sh > /var/log/dockerd.log 2>&1 &
        echo '→ Waiting for inner docker daemon...'
        until docker info >/dev/null 2>&1; do sleep 1; done
        apk add --no-cache bash curl openssl >/dev/null
        sed 's|__APPSTRATE_VERSION__|$VERSION|g' /install.sh > /tmp/i.sh
        chmod +x /tmp/i.sh
        bash /tmp/i.sh
        echo
        echo '→ Health check:'
        curl -fsS --max-time 5 http://localhost:$PORT >/dev/null && echo '  ✓ responding'
      "
    ;;
esac
