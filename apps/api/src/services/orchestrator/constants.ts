// SPDX-License-Identifier: Apache-2.0
//
// KEEP THIS FILE IMPORT-FREE. `services/docker.ts` reads from it, which is an
// upward import (the orchestrator layer consumes docker.ts, not the reverse).
// That is safe only while this module imports nothing: adding an import here
// that leads back to docker.ts creates a cycle. Stop policy genuinely belongs
// to the orchestrator layer, and the alternatives — a new file for one
// constant, or parameters whose only argument is ever that same constant —
// are worse. If this file ever needs an import, move the constants instead.

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
