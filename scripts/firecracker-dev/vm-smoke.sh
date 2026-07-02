#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Firecracker smoke suite — runs ON the Linux/KVM host (directly, or inside
# the Lima dev VM via run-in-vm.sh). Builds missing artifacts, runs the
# focused unit tests, then boots a real microVM through the orchestrator.
set -euo pipefail

cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }
[ -e /dev/kvm ] || { echo "/dev/kvm missing — KVM host required" >&2; exit 1; }

echo "==> bun install"
bun install --no-progress

KERNEL="./data/firecracker/vmlinux"
ROOTFS="./data/firecracker/rootfs.ext4"

if [ ! -f "$KERNEL" ]; then
  echo "==> Building guest kernel (Docker, ~15-25 min — cached afterwards)"
  bash scripts/firecracker/build-kernel.sh "$KERNEL"
fi

if [ ! -f "$ROOTFS" ] || [ "${FORCE_ROOTFS:-0}" = "1" ]; then
  echo "==> Building guest rootfs (first build compiles the pi + sidecar images — slow)"
  bash scripts/firecracker/build-rootfs.sh "$ROOTFS"
fi

echo "==> Unit tests (firecracker helpers)"
TEST_TIER=0 bun test apps/api/test/unit/services/firecracker

echo "==> End-to-end smoke (real microVM)"
bun run scripts/firecracker-dev/smoke.ts

echo "ALL FIRECRACKER CHECKS PASSED"
