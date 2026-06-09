// SPDX-License-Identifier: Apache-2.0

/**
 * Protected-resource registry primitives (`protected-resources.ts`). The
 * middleware behaviour is covered end-to-end in the mcp module's
 * `audience.test.ts`; here we test the registry resolution rules in isolation.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  registerProtectedResourceFamily,
  resetProtectedResources,
  snapshotProtectedResources,
  restoreProtectedResources,
  resolveProtectedResource,
  isProtectedResourceUri,
} from "../../src/lib/protected-resources.ts";

// The registry is a process-wide singleton shared with the live app. Snapshot it
// before this file mutates it and restore afterwards so we don't wipe the app's
// registrations for later files in the same `bun test` process (order-safe).
let resourceSnapshot: ReturnType<typeof snapshotProtectedResources>;
beforeAll(() => {
  resourceSnapshot = snapshotProtectedResources();
});
afterAll(() => {
  restoreProtectedResources(resourceSnapshot);
});

const mcpFamily = {
  prefix: "/api/mcp/o",
  deriveUri: (path: string) => {
    const id = path.slice("/api/mcp/o/".length);
    return id && !id.includes("/") ? `https://x/api/mcp/o/${id}` : undefined;
  },
  ownsUri: (uri: string) => uri.startsWith("https://x/api/mcp/o/"),
};

describe("protected-resource registry", () => {
  beforeEach(() => resetProtectedResources());

  it("resolves a dynamic family by deriving the URI from the path", () => {
    registerProtectedResourceFamily(mcpFamily);
    // A concrete org path (and any sub-path) resolves to its derived URI...
    expect(resolveProtectedResource("/api/mcp/o/acme")?.uri).toBe("https://x/api/mcp/o/acme");
    // ...but the family's bare prefix (no org segment) does not.
    expect(resolveProtectedResource("/api/mcp/o")).toBeUndefined();
    expect(resolveProtectedResource("/api/mcp/o/")).toBeUndefined();
    // `isProtectedResourceUri` matches the family's owned URIs + rejects others.
    expect(isProtectedResourceUri("https://x/api/mcp/o/acme")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/mcp/o/globex")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/other")).toBe(false);
  });

  it("does not match a path that merely shares a prefix string", () => {
    registerProtectedResourceFamily(mcpFamily);
    // `/api/mcp/ox` is NOT under `/api/mcp/o` (boundary is the slash).
    expect(resolveProtectedResource("/api/mcp/ox")).toBeUndefined();
    expect(resolveProtectedResource("/api/agents")).toBeUndefined();
  });

  it("matches the most specific (longest) prefix first", () => {
    registerProtectedResourceFamily({
      prefix: "/api/mcp",
      deriveUri: () => "broad",
      ownsUri: (u) => u === "broad",
    });
    registerProtectedResourceFamily(mcpFamily);
    expect(resolveProtectedResource("/api/mcp/o/acme")?.uri).toBe("https://x/api/mcp/o/acme");
    expect(resolveProtectedResource("/api/mcp/other")?.uri).toBe("broad");
  });

  it("re-registering a prefix replaces it (idempotent across reloads)", () => {
    registerProtectedResourceFamily({
      prefix: "/api/mcp/o",
      deriveUri: () => "v1",
      ownsUri: (u) => u === "v1",
    });
    registerProtectedResourceFamily(mcpFamily);
    expect(resolveProtectedResource("/api/mcp/o/acme")?.uri).toBe("https://x/api/mcp/o/acme");
    expect(isProtectedResourceUri("https://x/api/mcp/o/acme")).toBe(true);
    expect(isProtectedResourceUri("v1")).toBe(false);
  });

  it("is empty after reset", () => {
    registerProtectedResourceFamily(mcpFamily);
    resetProtectedResources();
    expect(isProtectedResourceUri("https://x/api/mcp/o/acme")).toBe(false);
    expect(resolveProtectedResource("/api/mcp/o/acme")).toBeUndefined();
  });
});
