#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build the guest kernel for the Firecracker orchestrator.
#
#   scripts/firecracker/build-kernel.sh [output-path]
#
# Why build instead of downloading the Firecracker CI kernels: the guest
# supervisor enforces the per-uid egress firewall with nftables, and the
# CI kernels ship with NO netfilter beyond legacy iptables filter/NAT —
# verified at runtime: `CONFIG_NF_TABLES is not set`,
# `CONFIG_NETFILTER_XT_MATCH_OWNER is not set`, everything =y (no
# modules), so the gap cannot be modprobe'd away. We therefore build the
# same pinned kernel series with the Firecracker project's own CI config
# as the base plus the netfilter options the guest needs.
#
# The build runs inside a Docker container (no host toolchain needed) and
# produces a single artifact. It is slow (~15-25 min) but one-time: the
# smoke harness and CI both cache the output by this script's hash.
#
# Env overrides:
#   KERNEL_VERSION   full kernel version to build   (default pinned below)
#   FIRECRACKER_REF  firecracker git ref for the base CI config
set -euo pipefail

OUT="${1:-./data/firecracker/vmlinux}"
ARCH="$(uname -m)"
KERNEL_VERSION="${KERNEL_VERSION:-6.1.102}"
FIRECRACKER_REF="${FIRECRACKER_REF:-v1.16.0}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_NAME="$(basename "$OUT")"

# The base config is the Firecracker project's CI config for this kernel
# series — the exact feature set their own test fleet boots (virtio-blk,
# virtio-net, ext4, overlayfs). We only ADD the netfilter support the
# guest supervisor depends on.
SERIES="${KERNEL_VERSION%.*}"
CONFIG_URL="https://raw.githubusercontent.com/firecracker-microvm/firecracker/${FIRECRACKER_REF}/resources/guest_configs/microvm-kernel-ci-${ARCH}-${SERIES}.config"

echo "==> Building vmlinux ${KERNEL_VERSION} (${ARCH}) in Docker"
docker run --rm \
  -e KERNEL_VERSION="$KERNEL_VERSION" \
  -e CONFIG_URL="$CONFIG_URL" \
  -e TARGET_ARCH="$ARCH" \
  -v "$OUT_DIR:/out" \
  ubuntu:24.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      build-essential bc bison flex libssl-dev libelf-dev \
      curl ca-certificates xz-utils python3 kmod cpio >/dev/null

    cd /tmp
    echo "==> Downloading linux-${KERNEL_VERSION}"
    # git.kernel.org snapshot rather than cdn.kernel.org tarballs — the CDN
    # is unreachable from some networks while the cgit snapshots stay up.
    curl -fsSL "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/snapshot/linux-${KERNEL_VERSION}.tar.gz" | tar -xz
    cd "linux-${KERNEL_VERSION}"

    echo "==> Base config: ${CONFIG_URL}"
    curl -fsSL -o .config "$CONFIG_URL"

    # Netfilter delta over the CI config:
    #  - NF_TABLES/NF_TABLES_INET: the guest supervisor uid firewall
    #    (meta skuid / ip daddr / tcp dport are nf_tables core
    #    expressions, no extra NFT_* options needed for filter rules).
    #  - NETFILTER_XT_MATCH_OWNER: iptables-legacy `-m owner` fallback.
    ./scripts/config \
      --enable CONFIG_NETFILTER \
      --enable CONFIG_NETFILTER_ADVANCED \
      --enable CONFIG_NETFILTER_NETLINK \
      --enable CONFIG_NF_TABLES \
      --enable CONFIG_NF_TABLES_INET \
      --enable CONFIG_NETFILTER_XT_MATCH_OWNER
    make olddefconfig

    # Confirm the delta survived olddefconfig (a missing dependency would
    # silently drop an option and we would only find out at smoke time).
    for opt in CONFIG_NF_TABLES CONFIG_NF_TABLES_INET CONFIG_NETFILTER_XT_MATCH_OWNER; do
      grep -q "^${opt}=y" .config || { echo "FATAL: ${opt} not enabled after olddefconfig" >&2; exit 1; }
    done

    echo "==> make -j$(nproc)"
    if [ "$TARGET_ARCH" = "aarch64" ]; then
      # Firecracker boots the PE-format Image on aarch64.
      make -j"$(nproc)" Image >/dev/null
      cp arch/arm64/boot/Image /out/.vmlinux.tmp
    else
      make -j"$(nproc)" vmlinux >/dev/null
      cp vmlinux /out/.vmlinux.tmp
    fi
  '

mv "$OUT_DIR/.vmlinux.tmp" "$OUT_DIR/$OUT_NAME"
echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1), arch $ARCH, kernel $KERNEL_VERSION)"
