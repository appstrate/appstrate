// SPDX-License-Identifier: Apache-2.0

// Sidecar cgroup memory limit. The sidecar's in-memory blob store caps
// itself at 128 MiB (`runtime-pi/sidecar/app.ts`, RUN_BLOB_STORE_MAX_BYTES)
// so its own guard fires before the kernel OOM-killer — keep that cap
// well below this value if either changes.
export const SIDECAR_MEMORY_BYTES = 256 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;

// SIGTERM→SIGKILL grace on stop, in seconds. Single-sourced across ALL THREE
// backends (docker, process, firecracker) so a cancel behaves the same
// whichever engine served the run. It lived as a literal `5` in each, with
// each copy's comment asserting it "matches" the others — exactly the drift
// this sweep single-sourced MAX_STREAMED_BODY_SIZE to prevent.
//
// Backend policy, not a caller option: `stopWorkload`/`stopByRunId` used to
// accept a `timeoutSeconds` that no production caller ever passed, so the
// parameter only ever selected this same default. Tests that need the grace
// out of the way inject it through the backend's deps bag instead.
export const SIGTERM_GRACE_SECONDS = 5;
