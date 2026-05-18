// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `computeToolUrlEnvelope` — Phase 4 of the AFPS niveau 2
 * scope model. The function takes the agent's tool selection × the
 * integration manifest's per-tool `urlPatterns` and returns the union
 * the MITM proxy enforces. Anchors three policy decisions:
 *
 *   1. Under-declared tools (no `urlPatterns`) bail out — we don't want
 *      to silently block legitimate traffic, so envelope = undefined.
 *   2. Pattern dedup unions methods conservatively: any "any-method"
 *      declaration on a pattern wins over method-restricted ones.
 *   3. Empty / undefined agent selection short-circuits to undefined.
 */

import { describe, it, expect } from "bun:test";
import { computeToolUrlEnvelope } from "../../../src/services/integration-spawn-resolver.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

function manifest(
  tools: Record<string, { urlPatterns?: { pattern: string; methods?: string[] }[] }>,
): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: "@vendor/test",
    version: "1.0.0",
    displayName: "Test",
    server: { type: "node", entryPoint: "index.js" },
    tools,
  } as unknown as IntegrationManifest;
}

describe("computeToolUrlEnvelope", () => {
  it("returns undefined when the agent did not restrict tools", () => {
    const m = manifest({
      list: { urlPatterns: [{ pattern: "https://api/list/**" }] },
    });
    expect(computeToolUrlEnvelope(m, undefined)).toBeUndefined();
  });

  it("returns undefined for an empty tool selection", () => {
    const m = manifest({
      list: { urlPatterns: [{ pattern: "https://api/list/**" }] },
    });
    expect(computeToolUrlEnvelope(m, [])).toBeUndefined();
  });

  it("returns undefined when any selected tool lacks urlPatterns", () => {
    const m = manifest({
      list: { urlPatterns: [{ pattern: "https://api/list/**" }] },
      send: {},
    });
    expect(computeToolUrlEnvelope(m, ["list", "send"])).toBeUndefined();
  });

  it("unions patterns across selected tools", () => {
    const m = manifest({
      list: { urlPatterns: [{ pattern: "https://api/list/**", methods: ["GET"] }] },
      search: { urlPatterns: [{ pattern: "https://api/search/**", methods: ["GET"] }] },
    });
    const env = computeToolUrlEnvelope(m, ["list", "search"]);
    expect(env).toEqual([
      { pattern: "https://api/list/**", methods: ["GET"] },
      { pattern: "https://api/search/**", methods: ["GET"] },
    ]);
  });

  it("merges methods when the same pattern appears with different methods", () => {
    const m = manifest({
      a: { urlPatterns: [{ pattern: "https://api/x/**", methods: ["GET"] }] },
      b: { urlPatterns: [{ pattern: "https://api/x/**", methods: ["POST"] }] },
    });
    const env = computeToolUrlEnvelope(m, ["a", "b"]);
    expect(env).toEqual([{ pattern: "https://api/x/**", methods: ["GET", "POST"] }]);
  });

  it("drops the methods restriction when the same pattern also appears with no methods", () => {
    const m = manifest({
      narrow: { urlPatterns: [{ pattern: "https://api/x/**", methods: ["GET"] }] },
      broad: { urlPatterns: [{ pattern: "https://api/x/**" }] },
    });
    const env = computeToolUrlEnvelope(m, ["narrow", "broad"]);
    expect(env).toEqual([{ pattern: "https://api/x/**" }]);
  });

  it("returns undefined when a selected tool exists but its urlPatterns is empty", () => {
    const m = manifest({
      list: { urlPatterns: [] },
    });
    expect(computeToolUrlEnvelope(m, ["list"])).toBeUndefined();
  });
});
