#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Firecracker smoke suite — runs ON the Linux/KVM host (directly, or inside
# the Lima dev VM via run-in-vm.sh). Builds missing artifacts, runs the
# focused unit tests, then boots a real microVM through the orchestrator.
set -euo pipefail

# DIAGNOSTIC ONLY (issue #2153, never merged): surface the tail of the smoke
# log as workflow annotations — the only CI output readable without log access.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -z "${DIAG_INNER:-}" ]; then
  export DIAG_INNER=1
  DIAG_LOG="$(mktemp)"
  set +e
  bash "$0" "$@" 2>&1 | tee "$DIAG_LOG"
  rc=${PIPESTATUS[0]}
  echo "::notice title=env::$(. /etc/os-release; echo "$PRETTY_NAME") kernel=$(uname -r) docker=$(docker version --format '{{.Server.Version}}' 2>&1 | head -1) runner=${ImageOS:-?}/${ImageVersion:-?}"
  python3 - "$DIAG_LOG" "$rc" <<'PY'
import re, sys
log, rc = sys.argv[1], int(sys.argv[2])
lines = [re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", l.rstrip("\r\n")) for l in open(log, errors="replace")]
enc = lambda t: t.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
hits = [l for l in lines if re.search(r"error|fail|denied|not found|SMOKE|==>", l, re.I)][:120]
print("::warning title=diag-grep::" + enc("\n".join(l[:300] for l in hits)))
if rc != 0:
    tail = lines[-300:]
    for i in range(0, len(tail), 30):
        print(f"::error title=diag-tail-{i // 30}::" + enc("\n".join(l[:400] for l in tail[i:i + 30])))
PY
  exit "$rc"
fi

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
