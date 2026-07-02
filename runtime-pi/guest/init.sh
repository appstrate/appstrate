#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate Firecracker guest PID 1.
#
# The rootfs block device is attached READ-ONLY (it is shared by every
# concurrent run), so the first job is a tmpfs-backed overlayfs over `/` —
# the canonical Firecracker pattern. After the pivot the guest sees a
# writable root whose writes land in RAM and die with the VM. Then mount
# the pseudo-filesystems + the config drive and hand off to the bun
# supervisor, which parses the launch spec and runs the workloads.
#
# This script never returns control to the kernel: every path ends in
# vm_exit (reboot=k on the cmdline turns that into VMM exit, which the
# host observes as run completion). stdout is the serial console.
set -u

# Firecracker exit is arch-specific: aarch64 PSCI powers off the VMM on
# `poweroff`, but x86 has no ACPI S5 emulation — `poweroff` merely halts
# the vCPU and the VMM lingers. A guest reboot (unimplemented by
# Firecracker) terminates the VMM on x86 instead.
vm_exit() {
  if [ "$(uname -m)" = "x86_64" ]; then reboot -f; else poweroff -f; fi
}

# PID 1 inherits the kernel's bare env — without sbin on PATH the
# supervisor can't find nft/setpriv, and the workloads expect bun.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

log() { echo "[appstrate-init] $*"; }

# --- Writable overlay over the read-only rootfs ----------------------------
# /overlay, /rom are baked into the rootfs image (see Dockerfile.rootfs).
# size=50% makes the kernel's silent 50%-of-RAM tmpfs default explicit: it
# caps the guest's writable space and is accounted in host capacity planning.
# No noexec — this tmpfs backs the writable root (incl. /workspace), and
# agents legitimately execute from it.
mount -t tmpfs -o nosuid,nodev,size=50% tmpfs /overlay \
  && mkdir -p /overlay/upper /overlay/work \
  && mount -t overlay overlay \
       -o lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work /mnt \
  && pivot_root /mnt /mnt/rom
if [ $? -ne 0 ]; then
  # No exit marker here: init cannot know the nonce (the config drive is
  # not mounted yet) and the host ignores nonce-less markers by design.
  log "FATAL: overlay/pivot_root failed (would-be exit 127)"
  vm_exit
fi

# --- Pseudo-filesystems (new root) -----------------------------------------
# hidepid=2: a workload uid must not enumerate (or read the environ of)
# another uid's processes — the sidecar env holds the run's credentials.
mount -t proc     -o hidepid=2 proc /proc
mount -t sysfs    sysfs    /sys     2>/dev/null || true
mount -t devtmpfs devtmpfs /dev     2>/dev/null || true
mkdir -p /dev/pts /dev/shm
mount -t devpts   devpts   /dev/pts 2>/dev/null || true
mount -t tmpfs -o nosuid,nodev tmpfs /dev/shm 2>/dev/null || true

# --- Base runtime environment ----------------------------------------------
# eth0 is configured by the kernel `ip=` boot arg; only loopback is manual.
ip link set lo up 2>/dev/null || true
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
chmod 1777 /tmp
mkdir -p /workspace /home/pi
chown 1001:1001 /home/pi
# Shared workspace: agent (1001) owns it; integration runners (1002) reach
# it through the `workspace` group (1003, baked into the rootfs). setgid
# keeps files created by either side group-shared.
chown 1001:1003 /workspace
chmod 2775 /workspace

# --- Config drive (second virtio-block device, read-only ext4) --------------
mkdir -p /config
if ! mount -t ext4 -o ro /dev/vdb /config; then
  # No exit marker: the nonce lives ON this drive, so init cannot emit a
  # marker the host would accept (nonce-less markers are ignored by design).
  log "FATAL: could not mount config drive (/dev/vdb) (would-be exit 127)"
  vm_exit
fi

log "handing off to supervisor"
/usr/local/bin/bun run /runtime/guest/supervisor.js
code=$?

# The supervisor normally prints its own nonce-bearing APPSTRATE_EXIT
# marker and powers off. Reaching here means it crashed before doing so —
# log and halt. No marker: init never learns the nonce and the host ignores
# nonce-less markers by design, so it reports a generic non-clean exit.
log "FATAL: supervisor exited ($code) without powering off (would-be exit $code)"
vm_exit
