// SPDX-License-Identifier: Apache-2.0
//
// KEEP THIS FILE'S IMPORTS TO `@appstrate/core` ALONE. `services/docker.ts` reads from it, which is
// an upward import (the orchestrator layer consumes docker.ts, not the reverse). That is safe only
// while this module imports nothing of this app: adding an import here that leads back to
// docker.ts creates a cycle.

import { SIDECAR_SIGTERM_GRACE_SECONDS } from "@appstrate/core/sidecar-types";

// Sidecar cgroup memory limit. The sidecar's in-memory blob store caps
// itself at 128 MiB (`runtime-pi/sidecar/app.ts`, RUN_BLOB_STORE_MAX_BYTES)
// so its own guard fires before the kernel OOM-killer — keep that cap
// well below this value if either changes.
export const SIDECAR_MEMORY_BYTES = 256 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;

// SIGTERM→SIGKILL grace on stop, in seconds, derived from the sidecar's journal-drain budget
// (`@appstrate/core/sidecar-types`) so a SIGTERM drain ends inside it. Single-sourced across ALL THREE
// backends (docker, process, firecracker) so a cancel behaves the same
// whichever engine served the run. Backend policy, not a caller option: tests that need the grace
// out of the way inject it through the backend's deps bag.
export const SIGTERM_GRACE_SECONDS = SIDECAR_SIGTERM_GRACE_SECONDS;
