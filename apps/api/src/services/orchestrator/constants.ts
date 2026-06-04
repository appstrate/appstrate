// SPDX-License-Identifier: Apache-2.0

export const SIDECAR_MEMORY_BYTES = 256 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;

/**
 * Minimum age before the periodic orphan reaper will remove a non-running
 * managed container. Generous on purpose: a healthy run is `running` for its
 * whole life (and so never a candidate), so this only bounds the window
 * between a terminal/`created` state and the lifecycle cleanup. An hour is far
 * longer than any create→start or exit→remove gap, so the reaper can never
 * race a launch that is merely slow.
 */
export const ORPHAN_REAP_MAX_AGE_SECONDS = 60 * 60;

/** How often the runtime-safe orphan reaper sweeps. */
export const ORPHAN_REAP_INTERVAL_MS = 30 * 60 * 1000;
