#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build the Firecracker guest rootfs (ext4) from the Docker images.
#
#   apps/api/src/modules/firecracker/scripts/build-rootfs.sh [output.ext4]
#
# Pipeline: docker build (Dockerfile.rootfs, merged pi+sidecar+guest image)
# → docker create + export → ext4 image via mkfs.ext4 -d. The extraction
# and mkfs run under `sudo -n` when not already root: the in-guest uid
# separation depends on baked ownership and on the setuid runner wrapper,
# both of which unprivileged tar/mkfs would silently strip.
#
# Requirements: docker, mkfs.ext4 (e2fsprogs). Linux-oriented — on macOS run
# inside the Lima dev VM (bun run firecracker:dev / apps/api/src/modules/firecracker/scripts/dev/).
#
# Env overrides:
#   PI_IMAGE / SIDECAR_IMAGE   base image refs (default local :latest)
#   ROOTFS_SIZE_MB             ext4 size (default: content + 40% headroom)
#   CHROMIUM_VERSION           exact Alpine repository version (required)
#   SKIP_BASE_BUILD=1          reuse existing pi/sidecar images
set -euo pipefail

cd "$(dirname "$0")/../../../../../.."
OUT="${1:-./data/firecracker/rootfs.ext4}"
PI_IMAGE="${PI_IMAGE:-appstrate-pi:latest}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-appstrate-sidecar:latest}"
ROOTFS_IMAGE_TAG="appstrate-fc-rootfs:latest"
ARCH="$(uname -m)"
: "${CHROMIUM_VERSION:?CHROMIUM_VERSION must be the exact pinned Alpine Chromium version}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v mkfs.ext4 >/dev/null || { echo "mkfs.ext4 (e2fsprogs) is required" >&2; exit 1; }

if [ "${SKIP_BASE_BUILD:-0}" != "1" ]; then
  echo "==> Building base images (pi + sidecar) for $ARCH"
  docker build --platform "linux/$([ "$ARCH" = "aarch64" ] && echo arm64 || echo amd64)" \
    -t "$PI_IMAGE" -f runtime-pi/Dockerfile .
  docker build --platform "linux/$([ "$ARCH" = "aarch64" ] && echo arm64 || echo amd64)" \
    -t "$SIDECAR_IMAGE" -f runtime-pi/sidecar/Dockerfile .
fi

echo "==> Building merged guest image"
docker build \
  --build-arg "PI_IMAGE=$PI_IMAGE" \
  --build-arg "SIDECAR_IMAGE=$SIDECAR_IMAGE" \
  --build-arg "CHROMIUM_VERSION=$CHROMIUM_VERSION" \
  -t "$ROOTFS_IMAGE_TAG" -f apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs .

echo "==> Exporting filesystem"
SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo -n"
STAGING="$(mktemp -d)"
trap '$SUDO rm -rf "$STAGING"; docker rm -f appstrate-fc-rootfs-export >/dev/null 2>&1 || true' EXIT
docker rm -f appstrate-fc-rootfs-export >/dev/null 2>&1 || true
docker create --name appstrate-fc-rootfs-export "$ROOTFS_IMAGE_TAG" /bin/true >/dev/null
# -p + --numeric-owner + root: preserve ownership and the setuid bit on
# /usr/local/bin/appstrate-runner-exec — the uid-separation contract.
docker export appstrate-fc-rootfs-export | $SUDO tar -xp --numeric-owner -C "$STAGING"
docker rm -f appstrate-fc-rootfs-export >/dev/null

# Docker export artifacts that must not leak into the guest.
$SUDO rm -rf "$STAGING/.dockerenv" "$STAGING/etc/hostname" "$STAGING/etc/resolv.conf" 2>/dev/null || true
$SUDO touch "$STAGING/etc/resolv.conf"

if [ -z "${ROOTFS_SIZE_MB:-}" ]; then
  CONTENT_MB="$($SUDO du -sm "$STAGING" | cut -f1)"
  ROOTFS_SIZE_MB=$(( CONTENT_MB * 14 / 10 + 64 ))
fi

echo "==> Creating ext4 image (${ROOTFS_SIZE_MB} MB) at $OUT"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
truncate -s "${ROOTFS_SIZE_MB}M" "$OUT"
$SUDO mkfs.ext4 -q -d "$STAGING" "$OUT"
# The image file itself must stay owned by the invoking user (the
# orchestrator reads it unprivileged).
$SUDO chown "$(id -u):$(id -g)" "$OUT"

echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1), arch $ARCH)"
