// SPDX-License-Identifier: Apache-2.0

// Sidecar cgroup memory limit. The sidecar's in-memory blob store caps
// itself at 128 MiB (`runtime-pi/sidecar/app.ts`, RUN_BLOB_STORE_MAX_BYTES)
// so its own guard fires before the kernel OOM-killer — keep that cap
// well below this value if either changes.
export const SIDECAR_MEMORY_BYTES = 256 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;
