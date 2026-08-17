// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the runtime-image warmer — the pass that keeps one pin
 * container per runtime image on the Docker host, so `docker image prune -a`
 * can't put a cold pull back on the run-boot critical path.
 *
 * Behaviours worth locking down: every image is offered to the pin reconciler
 * on every pass, and one broken image never costs the others their pin.
 * (That a pin holds the right image, converges, and survives the orphan
 * sweep is asserted against a real daemon in
 * `test/integration/services/docker-api.test.ts`.)
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  reconcileRuntimeImages,
  startRuntimeImageWarmer,
  stopRuntimeImageWarmer,
} from "../../../src/services/orchestrator/runtime-image-warmer.ts";

const IMAGES = [
  { image: "ghcr.io/appstrate/appstrate-pi:1.0.0", slot: "pi" },
  { image: "ghcr.io/appstrate/appstrate-sidecar:1.0.0", slot: "sidecar" },
];

describe("runtime image warmer", () => {
  it("offers every image to the pin reconciler and reports only what changed", async () => {
    const seen: Array<{ image: string; slot: string }> = [];
    const report = await reconcileRuntimeImages({
      images: IMAGES,
      ensureImagePin: async (image, slot) => {
        seen.push({ image, slot });
        // What a release bump looks like: the pi pin still held the old tag.
        return slot === "pi" ? "replaced" : "unchanged";
      },
    });

    expect(seen).toEqual(IMAGES.map(({ image, slot }) => ({ image, slot })));
    expect(report.pinned).toEqual(["pi"]);
  });

  it("reports nothing when every pin is already converged", async () => {
    const report = await reconcileRuntimeImages({
      images: IMAGES,
      ensureImagePin: async () => "unchanged",
    });

    expect(report.pinned).toEqual([]);
  });

  it("keeps sweeping the other images when one fails", async () => {
    const pinned: string[] = [];
    const report = await reconcileRuntimeImages({
      images: IMAGES,
      ensureImagePin: async (image, slot) => {
        if (image.includes("appstrate-pi")) throw new Error("docker daemon unreachable");
        pinned.push(slot);
        return "created";
      },
    });

    // A broken pi image must not cost the sidecar its pin — and the pass must
    // not throw: it runs on a timer with no caller to catch it.
    expect(pinned).toEqual(["sidecar"]);
    expect(report.pinned).toEqual(["sidecar"]);
  });
});

describe("runtime image warmer loop", () => {
  // The loop keeps module-level timer state — always retire it, or a leaked
  // timer keeps firing into the next test's assertions.
  afterEach(() => stopRuntimeImageWarmer());

  /** Wait until `predicate` holds or the budget expires (keeps tests fast). */
  async function waitFor(predicate: () => boolean, budgetMs = 500): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await Bun.sleep(1);
    }
  }

  it("does nothing at all when the interval disables it", async () => {
    // `0` is the documented opt-out for operators who manage image lifetime
    // themselves — it must create no pin containers, not just skip the timer.
    let passes = 0;
    startRuntimeImageWarmer({
      intervalSeconds: 0,
      images: IMAGES,
      ensureImagePin: async () => {
        passes++;
        return "unchanged";
      },
    });

    await Bun.sleep(30);
    expect(passes).toBe(0);
  });

  it("sweeps immediately and then keeps sweeping", async () => {
    // Immediately: a process that just booted may already be racing a prune
    // that happened while it was down.
    let passes = 0;
    startRuntimeImageWarmer({
      intervalSeconds: 0.01,
      images: [IMAGES[0]!],
      ensureImagePin: async () => {
        passes++;
        return "unchanged";
      },
    });

    await waitFor(() => passes >= 3);
    expect(passes).toBeGreaterThanOrEqual(3);
  });

  it("stops sweeping once stopped", async () => {
    let passes = 0;
    startRuntimeImageWarmer({
      intervalSeconds: 0.01,
      images: [IMAGES[0]!],
      ensureImagePin: async () => {
        passes++;
        return "unchanged";
      },
    });

    await waitFor(() => passes >= 1);
    stopRuntimeImageWarmer();
    const settled = passes;
    await Bun.sleep(50);
    expect(passes).toBe(settled);
  });
});
