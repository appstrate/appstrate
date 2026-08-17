// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image warmer — keeps `PI_IMAGE` / `SIDECAR_IMAGE` present on the
 * Docker host between runs, so no run ever pays a cold image pull on its boot
 * critical path.
 *
 * ## Why a loop, when the orchestrator already pulls at boot
 *
 * `DockerOrchestrator.initialize()` pre-pulls both images once per process
 * and caches "verified" for the process lifetime. That cache is a claim about
 * the host, and the host is shared: any external janitor — Coolify's nightly
 * automated cleanup, a cron `docker system prune`, a disk-pressure sweep —
 * deletes images no container references, which on an idle host is exactly
 * the runtime images. The claim then silently becomes false, and the next run
 * discovers it the expensive way (`createContainer` heals a `No such image`
 * 404 by pulling inline, mid-run, and hundreds of MB later the run has burnt
 * its provisioning budget).
 *
 * One mechanism does both jobs: reconcile a **pin container** per image
 * ({@link ensureImagePin}), the Docker-engine equivalent of containerd's
 * pinned-image label.
 *
 *  - It PREVENTS the deletion: prune never touches an image a container
 *    references, so a running pin keeps the image out of the janitor's reach.
 *  - It REPAIRS after one: a pin that is missing (fresh host, `container
 *    prune`, operator cleanup) gets recreated, and creating it pulls the
 *    image if the host no longer has it — off the run path.
 *
 * So "pin converged" already implies "image present", which is why this
 * sweep does not separately probe and pull the image: that check could only
 * ever fire for an image force-removed (`docker rmi -f`) out from under a
 * running container, a case the run path's inline 404 heal already covers.
 *
 * Nothing here is load-bearing for correctness — a missing image still heals
 * inline mid-run — it exists to keep boot latency inside the provisioning
 * budget.
 *
 * Docker-specific by construction: it manipulates images and containers on a
 * Docker daemon. Other backends manage image locality themselves (the
 * Firecracker daemon owns its own artifact cache), so boot only starts this
 * for `RUN_ADAPTER=docker`.
 */

import * as docker from "../docker.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface RuntimeImageWarmerDeps {
  /** Image references to keep warm, one pin slot each. */
  readonly images: readonly { image: string; slot: string }[];
  /** Injection seam for tests. Defaults to the real Docker call. */
  readonly ensureImagePin?: (
    image: string,
    slot: string,
  ) => Promise<"unchanged" | "created" | "replaced">;
}

export interface RuntimeImageWarmerReport {
  /** Slots whose pin container was created or replaced by this pass. */
  readonly pinned: string[];
}

/**
 * One reconcile pass, driven by {@link startRuntimeImageWarmer}. Exported for
 * tests; never throws — a Docker hiccup must not take down the API, and the
 * next tick retries.
 */
export async function reconcileRuntimeImages(
  deps: RuntimeImageWarmerDeps,
): Promise<RuntimeImageWarmerReport> {
  const ensureImagePin = deps.ensureImagePin ?? docker.ensureImagePin;

  const pinned: string[] = [];

  for (const { image, slot } of deps.images) {
    try {
      const outcome = await ensureImagePin(image, slot);
      if (outcome !== "unchanged") {
        // Deliberately loud: a converged pin is the steady state, so a pass
        // that had to create or replace one means something on this host
        // removed it — the very janitor whose invisible nightly re-pull this
        // module exists to stop. Silent self-healing would hide it again.
        logger.warn("runtime image pin was missing — recreated", { image, slot, outcome });
        pinned.push(slot);
      }
    } catch (err) {
      logger.warn("runtime image warm pass failed for image", {
        image,
        slot,
        error: getErrorMessage(err),
      });
    }
  }

  return { pinned };
}

let warmerTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export interface RuntimeImageWarmerConfig extends RuntimeImageWarmerDeps {
  /** Sweep cadence in seconds. `0` disables the warmer entirely. */
  readonly intervalSeconds: number;
}

/**
 * Start the periodic warmer. The first pass runs immediately (a process that
 * just booted may already be racing a prune from before it started), then
 * every `intervalSeconds`.
 */
export function startRuntimeImageWarmer(config: RuntimeImageWarmerConfig): void {
  if (config.intervalSeconds <= 0) return;
  stopped = false;

  const tick = (): void => {
    void reconcileRuntimeImages(config).finally(() => {
      if (stopped) return;
      warmerTimer = setTimeout(tick, config.intervalSeconds * 1000);
    });
  };

  logger.info("runtime image warmer started", { intervalSeconds: config.intervalSeconds });
  tick();
}

export function stopRuntimeImageWarmer(): void {
  stopped = true;
  if (warmerTimer) {
    clearTimeout(warmerTimer);
    warmerTimer = null;
  }
}
