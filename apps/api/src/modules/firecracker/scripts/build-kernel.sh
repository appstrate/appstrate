#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build the guest kernel for the Firecracker orchestrator.
#
#   apps/api/src/modules/firecracker/scripts/build-kernel.sh [output-path]
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
#   KERNEL_COMMIT    expected commit sha of the kernel tag (supply-chain pin;
#                    MUST be updated together with KERNEL_VERSION)
#   FIRECRACKER_REF  firecracker git ref for the base CI config
#   CONFIG_SHA256    expected sha256 of the base CI config for this arch
#                    (MUST be updated together with FIRECRACKER_REF)
set -euo pipefail

OUT="${1:-./data/firecracker/vmlinux}"
ARCH="$(uname -m)"
KERNEL_VERSION="${KERNEL_VERSION:-6.1.102}"
# `git ls-remote <stable> 'v6.1.102^{}'` — the dereferenced tag commit.
KERNEL_COMMIT="${KERNEL_COMMIT:-c1cec4dad96b5e49c2b7680f7246acf58d4c87da}"
FIRECRACKER_REF="${FIRECRACKER_REF:-v1.16.0}"
if [ -z "${CONFIG_SHA256:-}" ]; then
  case "$ARCH" in
    x86_64)  CONFIG_SHA256="adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b" ;;
    aarch64) CONFIG_SHA256="1df6e14391ef65eceac0f65cac4e431fefd8e04e4584d261184059320ad492b7" ;;
    *) echo "unsupported arch $ARCH (set CONFIG_SHA256 explicitly)" >&2; exit 1 ;;
  esac
fi

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
  -e KERNEL_COMMIT="$KERNEL_COMMIT" \
  -e CONFIG_URL="$CONFIG_URL" \
  -e CONFIG_SHA256="$CONFIG_SHA256" \
  -e TARGET_ARCH="$ARCH" \
  -v "$OUT_DIR:/out" \
  ubuntu:24.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      build-essential bc bison flex libssl-dev libelf-dev \
      curl ca-certificates xz-utils python3 kmod cpio git >/dev/null

    cd /tmp
    echo "==> Cloning linux ${KERNEL_VERSION}"
    # Shallow tag clone + commit-sha verification instead of a snapshot
    # tarball: cgit snapshots are generated per-request (no stable hash to
    # pin), while the tag commit sha IS the content pin — a moved tag or a
    # tampered mirror fails loudly here.
    git clone --depth 1 --branch "v${KERNEL_VERSION}" \
      https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git "linux-${KERNEL_VERSION}"
    cd "linux-${KERNEL_VERSION}"
    actual="$(git rev-parse HEAD)"
    if [ "$actual" != "$KERNEL_COMMIT" ]; then
      echo "FATAL: kernel tag v${KERNEL_VERSION} resolves to ${actual}, expected ${KERNEL_COMMIT}" >&2
      exit 1
    fi

    echo "==> Base config: ${CONFIG_URL}"
    curl -fsSL -o .config "$CONFIG_URL"
    echo "${CONFIG_SHA256}  .config" | sha256sum -c - >/dev/null \
      || { echo "FATAL: base kernel config checksum mismatch" >&2; exit 1; }

    # Netfilter + Chromium sandbox delta over the CI config:
    #  - NF_TABLES/NF_TABLES_INET: the guest supervisor uid firewall
    #    (meta skuid / ip daddr / tcp dport are nf_tables core
    #    expressions, no extra NFT_* options needed for filter rules).
    #  - NETFILTER_XT_MATCH_OWNER: iptables-legacy `-m owner` fallback.
    #  - namespace + seccomp options: the Chromium unprivileged namespace
    #    sandbox. The rootfs strips the setuid bit from chromium-sandbox, so silently
    #    shipping a kernel without these would make every browser worker fail
    #    (or tempt callers to add --no-sandbox).
    ./scripts/config \
      --enable CONFIG_NETFILTER \
      --enable CONFIG_NETFILTER_ADVANCED \
      --enable CONFIG_NETFILTER_NETLINK \
      --enable CONFIG_NF_TABLES \
      --enable CONFIG_NF_TABLES_INET \
      --enable CONFIG_NETFILTER_XT_MATCH_OWNER \
      --enable CONFIG_NAMESPACES \
      --enable CONFIG_UTS_NS \
      --enable CONFIG_IPC_NS \
      --enable CONFIG_USER_NS \
      --enable CONFIG_PID_NS \
      --enable CONFIG_NET_NS \
      --enable CONFIG_SECCOMP \
      --enable CONFIG_SECCOMP_FILTER
    make olddefconfig

    # Confirm the delta survived olddefconfig (a missing dependency would
    # silently drop an option and we would only find out at smoke time).
    for opt in \
      CONFIG_NF_TABLES CONFIG_NF_TABLES_INET CONFIG_NETFILTER_XT_MATCH_OWNER \
      CONFIG_NAMESPACES CONFIG_UTS_NS CONFIG_IPC_NS CONFIG_USER_NS CONFIG_PID_NS CONFIG_NET_NS \
      CONFIG_SECCOMP CONFIG_SECCOMP_FILTER; do
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
