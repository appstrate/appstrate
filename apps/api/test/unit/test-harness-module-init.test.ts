// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the test harness itself: every discovered module must have gone
 * through the real `init(ctx)` pipeline before any test mounts its router.
 *
 * The harness used to skip `init()` and call `createRouter()` straight off the
 * discovered module (issue #989). Modules that carried a no-context fallback
 * then served requests against a degraded dependency baseline — for chat that
 * meant the #968/#971 admission gate answering `null` (fail-open) and the #965
 * file teardown resolving to a no-op. Any test that believed it exercised
 * those guards exercised nothing, and would have kept passing if either guard
 * were deleted outright.
 *
 * These assertions fail loudly if the preload's Phase 3 is ever removed or
 * reordered, which is the only way that class of blind spot can come back.
 */

import { describe, it, expect } from "bun:test";
import { getModules } from "../../src/lib/modules/module-loader.ts";
import { getDiscoveredModules } from "../helpers/test-modules.ts";

describe("test harness — module init parity with production", () => {
  it("discovers at least the built-in modules", () => {
    // Sanity floor: if discovery silently found nothing, every assertion
    // below would pass vacuously.
    expect(getDiscoveredModules().length).toBeGreaterThan(0);
  });

  it("registers every discovered module in the loader (init() ran)", () => {
    // `_modules` is populated only AFTER `await mod.init(ctx)` returns
    // (`initSortedModules`), so a module present here provably initialized.
    const registered = getModules();
    for (const mod of getDiscoveredModules()) {
      expect(registered.has(mod.manifest.id)).toBe(true);
    }
    expect(registered.size).toBe(getDiscoveredModules().length);
  });

  it("wires the chat module's real platform deps, not a degraded baseline", () => {
    // Resolve through DISCOVERY, not the loader registry: reading it from
    // `getModules()` would make this test vacuous the moment init stops
    // running (an unregistered module would just be skipped) — which is the
    // exact failure it exists to catch.
    const chat = getDiscoveredModules().find((m) => m.manifest.id === "chat");
    if (!chat) return; // module-chat absent from this checkout — nothing to pin.
    // Before #989 this returned a router built on fail-open deps. It now
    // throws when `init()` has not run, so a successful call is itself the
    // proof that the harness supplied a real context.
    expect(() => chat.createRouter?.()).not.toThrow();
  });
});
