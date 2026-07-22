// SPDX-License-Identifier: Apache-2.0

// Sidecar cgroup memory limit. The sidecar's in-memory blob store caps
// itself at 128 MiB (`runtime-pi/sidecar/app.ts`, RUN_BLOB_STORE_MAX_BYTES)
// so its own guard fires before the kernel OOM-killer — keep that cap
// well below this value if either changes.
// 512 MiB (was 256): with 256 the sidecar's standalone Bun binary
// segfaulted intermittently (~3 boots out of 9) right at the
// allocation-heavy first LLM streaming moment — on BOTH Bun 1.3.13 and
// 1.3.14, at different addresses, with every crash report showing the
// 256 MiB ceiling (`Machine: 0.27GB`) while peak RSS sat near 120 MB.
// JSC's JIT/GC under a tight cgroup is the suspected mechanism. The
// blob-store cap (128 MiB) still sits well below this value.
export const SIDECAR_MEMORY_BYTES = 512 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;
