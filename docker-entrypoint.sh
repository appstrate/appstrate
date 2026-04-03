#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Entrypoint wrapper: ensures the bun user can access the Docker socket.
# The Docker socket's group varies per host (often 988, 999, or 998).
# This script detects the GID at runtime and adds bun to that group.

SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"

if [ -S "$SOCKET" ] && [ "$(id -u)" = "0" ]; then
  SOCK_GID=$(stat -c '%g' "$SOCKET" 2>/dev/null)
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    # Create a group with the socket's GID if it doesn't exist
    if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
      addgroup -g "$SOCK_GID" -S dockersock 2>/dev/null || true
    fi
    SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
    addgroup bun "$SOCK_GROUP" 2>/dev/null || true
  fi
  exec su-exec bun "$@"
else
  exec "$@"
fi
