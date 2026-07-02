#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Firecracker dev entrypoint — `bun run test:firecracker`.
#
# On Linux (KVM host or CI runner): run the smoke suite directly.
# On macOS: ensure the Lima dev VM (apps/api/src/modules/firecracker/scripts/dev/lima.yaml) is
# up, rsync the repo onto the VM's own disk (the host mount is read-only —
# see lima.yaml header), and run the same suite inside.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../../../../.." && pwd)"

if [ "$(uname)" = "Linux" ]; then
  exec bash "$REPO/apps/api/src/modules/firecracker/scripts/dev/vm-smoke.sh"
fi

VM="appstrate-fc-dev"
command -v limactl >/dev/null || {
  echo "Lima is required on macOS: brew install lima" >&2
  exit 1
}

if ! limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$VM"; then
  echo "==> Creating Lima VM '$VM' (first run — downloads Ubuntu image)"
  limactl start --name "$VM" --tty=false "$REPO/apps/api/src/modules/firecracker/scripts/dev/lima.yaml"
elif [ "$(limactl list --format '{{.Status}}' "$VM")" != "Running" ]; then
  limactl start "$VM"
fi

echo "==> Syncing repo to VM disk"
limactl shell "$VM" -- bash -c "
  set -euo pipefail
  mkdir -p ~/appstrate-fc
  # /data anchored to the repo root: package-relative data/ dirs (e.g.
  # core-providers/data/featured-models.json) must sync, while the root
  # data/ (VM-built kernel/rootfs artifacts, PGlite state) must survive
  # --delete between runs.
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude /data --exclude dist \
    --exclude '.turbo' --exclude 'e2e/test-results' \
    '$REPO/' ~/appstrate-fc/
"

echo "==> Running Firecracker smoke suite inside VM"
limactl shell "$VM" -- bash -lc "cd ~/appstrate-fc && FORCE_ROOTFS='${FORCE_ROOTFS:-0}' bash apps/api/src/modules/firecracker/scripts/dev/vm-smoke.sh"
