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
 * Two mechanisms, deliberately both:
 *
 *  - **re-pull sweep** — restores an image that went missing, off the run
 *    path. Equivalent of a Kubernetes image pre-puller DaemonSet. Also makes
 *    the orchestrator's "verified" cache true again without invalidation
 *    plumbing: the cache says the image is present, and after the pull it is.
 *  - **pin containers** — stop the deletion happening at all
 *    ({@link ensureImagePin}). Equivalent of containerd's pinned-image label.
 *
 * The pin is the fix; the sweep is what makes the fix self-healing on hosts
 * where the pin was removed anyway (operator cleanup, `container prune`,
 * fresh host). Neither is load-bearing for correctness — a missing image
 * still heals inline — they exist to keep boot latency inside the
 * provisioning budget.
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
  /** Image references to keep warm, resolved per pass (env may be re-read). */
  readonly images: () => readonly { image: string; slot: string }[];
  readonly hasImageLocally?: (image: string) => Promise<boolean>;
  readonly pullImage?: (image: string) => Promise<void>;
  readonly ensureImagePin?: (
    image: string,
    slot: string,
  ) => Promise<"unchanged" | "created" | "replaced">;
}

export interface RuntimeImageWarmerReport {
  /** Images that were missing and got re-pulled by this pass. */
  readonly pulled: string[];
  /** Slots whose pin container was created or replaced by this pass. */
  readonly pinned: string[];
}

/**
 * One reconcile pass. Exported for tests and for the boot-time invocation;
 * never throws — a Docker hiccup must not take down the API, and the next
 * tick retries.
 */
export async function reconcileRuntimeImages(
  deps: RuntimeImageWarmerDeps,
): Promise<RuntimeImageWarmerReport> {
  const hasImageLocally = deps.hasImageLocally ?? docker.hasImageLocally;
  const pullImage = deps.pullImage ?? docker.pullImage;
  const ensureImagePin = deps.ensureImagePin ?? docker.ensureImagePin;

  const pulled: string[] = [];
  const pinned: string[] = [];

  for (const { image, slot } of deps.images()) {
    try {
      if (!(await hasImageLocally(image))) {
        // Deliberately loud: an image vanishing between runs means something
        // on this host is pruning them, and that is worth an operator's
        // attention — silent self-healing here would hide a recurring
        // multi-hundred-MB pull that only shows up as slow runs.
        logger.warn("runtime image missing from host — re-pulling off the run path", {
          image,
          slot,
        });
        await pullImage(image);
        pulled.push(image);
      }

      const pinOutcome = await ensureImagePin(image, slot);
      if (pinOutcome !== "unchanged") {
        logger.info("runtime image pin reconciled", { image, slot, outcome: pinOutcome });
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

  return { pulled, pinned };
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
