#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Fetch the guest kernel for the Firecracker orchestrator.
#
#   scripts/firecracker/fetch-kernel.sh [output-path]
#
# Uses the Firecracker project's CI kernels (spec.ccfc.min S3 bucket) —
# uncompressed vmlinux images with virtio-{blk,net}, ext4, overlayfs and
# nftables compiled in, the exact feature set the guest init/supervisor
# depend on. The kernel series is PINNED; bump deliberately and re-run the
# smoke test (scripts/firecracker-dev/) when changing it.
#
# Env overrides:
#   FIRECRACKER_CI_PREFIX   CI artifacts prefix (default pinned below)
#   KERNEL_SERIES           kernel major.minor to select (default 6.1)
set -euo pipefail

OUT="${1:-./data/firecracker/vmlinux}"
ARCH="$(uname -m)"
S3="https://s3.amazonaws.com/spec.ccfc.min"
KERNEL_SERIES="${KERNEL_SERIES:-6.1}"

if [ -z "${FIRECRACKER_CI_PREFIX:-}" ]; then
  # Latest published CI prefix. Listed (not hardcoded) because the bucket
  # rotates prefixes per release train; the kernel SERIES stays pinned.
  FIRECRACKER_CI_PREFIX="$(curl -fsSL "$S3?list-type=2&prefix=firecracker-ci/&delimiter=/" \
    | grep -oE '<Prefix>firecracker-ci/[^<]+/</Prefix>' \
    | sed -E 's|</?Prefix>||g' | sort | tail -1)"
fi

KEY="$(curl -fsSL "$S3?list-type=2&prefix=${FIRECRACKER_CI_PREFIX}${ARCH}/vmlinux-${KERNEL_SERIES}" \
  | grep -oE "<Key>${FIRECRACKER_CI_PREFIX}${ARCH}/vmlinux-${KERNEL_SERIES}\.[0-9]+</Key>" \
  | sed -E 's|</?Key>||g' | sort -V | tail -1)"

if [ -z "$KEY" ]; then
  echo "No vmlinux-${KERNEL_SERIES}.x found under ${FIRECRACKER_CI_PREFIX}${ARCH}/" >&2
  exit 1
fi

echo "==> Fetching $KEY"
mkdir -p "$(dirname "$OUT")"
curl -fsSL -o "$OUT" "$S3/$KEY"
echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1), arch $ARCH)"
