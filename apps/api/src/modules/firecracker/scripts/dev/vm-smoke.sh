#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Firecracker smoke suite — runs ON the Linux/KVM host (directly, or inside
# the Lima dev VM via run-in-vm.sh). Builds missing artifacts, runs the
# focused unit tests, then boots a real microVM through the orchestrator.
set -euo pipefail

cd "$(dirname "$0")/../../../../../../.."
export PATH="$HOME/.bun/bin:$PATH"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }
[ -e /dev/kvm ] || { echo "/dev/kvm missing — KVM host required" >&2; exit 1; }

echo "==> bun install"
bun install --no-progress

KERNEL="./data/firecracker/vmlinux"
ROOTFS="./data/firecracker/rootfs.ext4"

if [ ! -f "$KERNEL" ]; then
  echo "==> Building guest kernel (Docker, ~15-25 min — cached afterwards)"
  bash apps/api/src/modules/firecracker/scripts/build-kernel.sh "$KERNEL"
fi

if [ ! -f "$ROOTFS" ] || [ "${FORCE_ROOTFS:-0}" = "1" ]; then
  echo "==> Building guest rootfs (first build compiles the pi + sidecar images — slow)"
  bash apps/api/src/modules/firecracker/scripts/build-rootfs.sh "$ROOTFS"
fi

echo "==> Unit tests (firecracker helpers)"
TEST_TIER=0 bun test apps/api/src/modules/firecracker/test/unit

echo "==> End-to-end smoke (real microVM, jailed VMM)"
# Root: the orchestrator's default FIRECRACKER_JAILER=on chroots each VMM
# and drops it to a per-VM uid — same posture as the production daemon
# (systemd User=root). `-E` + explicit PATH keep the FIRECRACKER_* env
# and the caller's bun/jailer resolution across the sudo boundary.
if [ "$(id -u)" = "0" ]; then
  bun run apps/api/src/modules/firecracker/scripts/dev/smoke.ts
else
  sudo -E env "PATH=$PATH" bun run apps/api/src/modules/firecracker/scripts/dev/smoke.ts
fi

echo "ALL FIRECRACKER CHECKS PASSED"
