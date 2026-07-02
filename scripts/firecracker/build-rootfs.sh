#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build the Firecracker guest rootfs (ext4) from the Docker images.
#
#   scripts/firecracker/build-rootfs.sh [output.ext4]
#
# Pipeline: docker build (Dockerfile.rootfs, merged pi+sidecar+guest image)
# → docker create + export → ext4 image via mkfs.ext4 -d (no root needed).
#
# Requirements: docker, mkfs.ext4 (e2fsprogs). Linux-oriented — on macOS run
# inside the Lima dev VM (bun run firecracker:dev / scripts/firecracker-dev/).
#
# Env overrides:
#   PI_IMAGE / SIDECAR_IMAGE   base image refs (default local :latest)
#   ROOTFS_SIZE_MB             ext4 size (default: content + 40% headroom)
#   SKIP_BASE_BUILD=1          reuse existing pi/sidecar images
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT="${1:-./data/firecracker/rootfs.ext4}"
PI_IMAGE="${PI_IMAGE:-appstrate-pi:latest}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-appstrate-sidecar:latest}"
ROOTFS_IMAGE_TAG="appstrate-fc-rootfs:latest"
ARCH="$(uname -m)"

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
  -t "$ROOTFS_IMAGE_TAG" -f scripts/firecracker/Dockerfile.rootfs .

echo "==> Exporting filesystem"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"; docker rm -f appstrate-fc-rootfs-export >/dev/null 2>&1 || true' EXIT
docker rm -f appstrate-fc-rootfs-export >/dev/null 2>&1 || true
docker create --name appstrate-fc-rootfs-export "$ROOTFS_IMAGE_TAG" /bin/true >/dev/null
docker export appstrate-fc-rootfs-export | tar -x -C "$STAGING"
docker rm -f appstrate-fc-rootfs-export >/dev/null

# Docker export artifacts that must not leak into the guest.
rm -rf "$STAGING/.dockerenv" "$STAGING/etc/hostname" "$STAGING/etc/resolv.conf" 2>/dev/null || true
touch "$STAGING/etc/resolv.conf"

if [ -z "${ROOTFS_SIZE_MB:-}" ]; then
  CONTENT_MB="$(du -sm "$STAGING" | cut -f1)"
  ROOTFS_SIZE_MB=$(( CONTENT_MB * 14 / 10 + 64 ))
fi

echo "==> Creating ext4 image (${ROOTFS_SIZE_MB} MB) at $OUT"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
truncate -s "${ROOTFS_SIZE_MB}M" "$OUT"
mkfs.ext4 -q -d "$STAGING" "$OUT"

echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1), arch $ARCH)"
