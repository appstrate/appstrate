// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-phase liveness pump — the platform attesting, on the runner's behalf,
 * that a run it is still provisioning is alive.
 *
 * ## Why this exists
 *
 * A run's sink opens at creation, which is also when the stall watchdog
 * starts watching `runs.last_heartbeat_at`. But between creation and the
 * runner's FIRST event nothing is running that could heartbeat: the platform
 * is still pulling images, creating the isolation boundary, and booting the
 * workload. On a cold host that window legitimately exceeds
 * `RUN_STALL_THRESHOLD_SECONDS` — a runtime image pull alone can run past a
 * minute — and the watchdog then kills a perfectly healthy run with
 * "Runner stopped reporting", an error describing something that never
 * happened.
 *
 * This is the same split Kubernetes draws between `startupProbe` and
 * `livenessProbe`: a generous budget while the workload comes up, an
 * aggressive one once it reports. Here the "startup probe" is the
 * provisioner itself, which knows exactly what it is doing and can say so.
 *
 * ## The honesty constraints
 *
 * An attestation is only useful if it cannot be given for a run that is
 * actually dead, so the pump is bounded on three sides:
 *
 *  1. `isAlive()` — the backend's own liveness probe. `false` stops the pump
 *     immediately (the workload died; let the watchdog do its job). `null`
 *     means "unknown" (probe failed, older daemon): the beat is SKIPPED, not
 *     assumed — degrade toward the watchdog, never away from it.
 *  2. `last_event_sequence = 0` — enforced inside {@link recordBootHeartbeat}.
 *     The moment the runner speaks for itself, real liveness takes over and
 *     the pump retires (`guest-active`).
 *  3. `boot_deadline_at` — also enforced in the DB write. A wedged
 *     provisioner (hung daemon call, unreachable registry) cannot keep a run
 *     alive forever; past the ceiling the bump is refused
 *     (`deadline-passed`), the pump stops, and the watchdog's
 *     startup-deadline predicate finalises the row with an accurate error.
 *
 * The pump is deliberately topology-agnostic — Docker containers and
 * Firecracker microVMs boot differently but share this window, and the
 * watchdog they are racing makes no distinction between run origins either.
 */

import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { recordBootHeartbeat, type BootHeartbeatOutcome } from "./state/runs.ts";

export interface BootHeartbeatOptions {
  readonly runId: string;
  /** Beat cadence. Should be well under `RUN_STALL_THRESHOLD_SECONDS`. */
  readonly intervalMs: number;
  /**
   * Backend liveness probe for the thing being provisioned. `true` = alive
   * (beat), `false` = dead (stop the pump), `null` = unknown (skip this beat
   * and retry next tick).
   *
   * Omit when the provisioning work itself is the liveness proof: the caller
   * runs the pump for exactly as long as its own provisioning code is in
   * flight and stops it in a `finally`, so "the pump is running" already
   * means "this process is still working on the run". The `boot_deadline_at`
   * ceiling bounds that claim.
   */
  readonly isAlive?: () => Promise<boolean | null>;
  /** Injection seam for tests. Defaults to the real DB write. */
  readonly record?: (runId: string) => Promise<BootHeartbeatOutcome>;
  /** Label used in log lines to name the backend (e.g. `docker`, `firecracker`). */
  readonly backend: string;
}

/**
 * Start the pump. Returns an idempotent stop function; the pump also stops
 * itself on any terminal outcome (see the constraints above).
 */
export function startBootHeartbeat(options: BootHeartbeatOptions): () => void {
  const record = options.record ?? recordBootHeartbeat;
  const { runId, intervalMs, isAlive, backend } = options;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  const tick = (): void => {
    void (async () => {
      if (stopped) return;

      if (isAlive) {
        let alive: boolean | null;
        try {
          alive = await isAlive();
        } catch (err) {
          // A throwing probe is "unknown", not "alive" — same degrade path.
          logger.debug("boot heartbeat: liveness probe threw — skipping beat", {
            runId,
            backend,
            error: getErrorMessage(err),
          });
          return schedule();
        }
        if (stopped) return;
        // Confirmed dead — stop so the watchdog catches a genuinely dead run
        // instead of us masking it.
        if (alive === false) return stop();
        // Unknown — skip this beat rather than assume alive.
        if (alive === null) return schedule();
      }

      let outcome: BootHeartbeatOutcome;
      try {
        outcome = await record(runId);
      } catch (err) {
        logger.warn("boot heartbeat write failed — retrying", {
          runId,
          backend,
          error: getErrorMessage(err),
        });
        return schedule();
      }
      if (stopped) return;

      if (outcome === "deadline-passed") {
        logger.warn("boot heartbeat: run blew its provisioning deadline", { runId, backend });
        return stop();
      }
      // Runner now reporting, or run closed — real liveness takes over.
      if (outcome !== "bumped") return stop();
      schedule();
    })();
  };

  schedule();
  return stop;
}
