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

import { describe, it, expect } from "bun:test";
import { reconcileRuntimeImages } from "../../../src/services/orchestrator/runtime-image-warmer.ts";

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
