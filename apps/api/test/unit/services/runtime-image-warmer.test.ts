// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the runtime-image warmer — the pass that keeps
 * PI_IMAGE/SIDECAR_IMAGE present and pinned on the Docker host so no run
 * pays a cold pull on its boot critical path.
 *
 * The behaviours worth locking down: don't re-pull what's already there,
 * DO re-pull what a host janitor deleted, always reconcile the pin, and
 * never let one broken image take down the sweep for the other.
 */

import { describe, it, expect } from "bun:test";
import { reconcileRuntimeImages } from "../../../src/services/orchestrator/runtime-image-warmer.ts";

const IMAGES = [
  { image: "ghcr.io/appstrate/appstrate-pi:1.0.0", slot: "pi" },
  { image: "ghcr.io/appstrate/appstrate-sidecar:1.0.0", slot: "sidecar" },
];

describe("runtime image warmer", () => {
  it("does not pull images that are already on the host", async () => {
    const pulls: string[] = [];
    const report = await reconcileRuntimeImages({
      images: () => IMAGES,
      hasImageLocally: async () => true,
      pullImage: async (image) => {
        pulls.push(image);
      },
      ensureImagePin: async () => "unchanged",
    });

    expect(pulls).toEqual([]);
    expect(report.pulled).toEqual([]);
    expect(report.pinned).toEqual([]);
  });

  it("re-pulls an image a host janitor deleted, off the run path", async () => {
    const pulls: string[] = [];
    const report = await reconcileRuntimeImages({
      images: () => IMAGES,
      // The pi image vanished (nightly `docker image prune -a`).
      hasImageLocally: async (image) => !image.includes("appstrate-pi"),
      pullImage: async (image) => {
        pulls.push(image);
      },
      ensureImagePin: async () => "unchanged",
    });

    expect(pulls).toEqual(["ghcr.io/appstrate/appstrate-pi:1.0.0"]);
    expect(report.pulled).toEqual(["ghcr.io/appstrate/appstrate-pi:1.0.0"]);
  });

  it("reconciles a pin whose image reference drifted (the release-bump case)", async () => {
    const pinned: Array<{ image: string; slot: string }> = [];
    const report = await reconcileRuntimeImages({
      images: () => IMAGES,
      hasImageLocally: async () => true,
      pullImage: async () => {},
      ensureImagePin: async (image, slot) => {
        pinned.push({ image, slot });
        return slot === "pi" ? "replaced" : "unchanged";
      },
    });

    // Every image is offered to the pin reconciler, every pass.
    expect(pinned).toEqual(IMAGES.map(({ image, slot }) => ({ image, slot })));
    expect(report.pinned).toEqual(["pi"]);
  });

  it("pins an image it had to pull first", async () => {
    const order: string[] = [];
    await reconcileRuntimeImages({
      images: () => [IMAGES[0]!],
      hasImageLocally: async () => false,
      pullImage: async () => {
        order.push("pull");
      },
      ensureImagePin: async () => {
        order.push("pin");
        return "created";
      },
    });

    // Pin after pull — pinning a reference the host doesn't have would fail.
    expect(order).toEqual(["pull", "pin"]);
  });

  it("keeps sweeping the other images when one fails", async () => {
    const pinned: string[] = [];
    const report = await reconcileRuntimeImages({
      images: () => IMAGES,
      hasImageLocally: async (image) => {
        if (image.includes("appstrate-pi")) throw new Error("docker daemon unreachable");
        return true;
      },
      pullImage: async () => {},
      ensureImagePin: async (_image, slot) => {
        pinned.push(slot);
        return "created";
      },
    });

    // A broken pi image must not cost the sidecar its warm-keeping — and the
    // pass must not throw: it runs on a timer with no caller to catch it.
    expect(pinned).toEqual(["sidecar"]);
    expect(report.pinned).toEqual(["sidecar"]);
  });
});
