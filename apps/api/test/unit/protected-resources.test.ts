// SPDX-License-Identifier: Apache-2.0

/**
 * Protected-resource registry primitives (`protected-resources.ts`). The
 * middleware behaviour is covered end-to-end in the mcp module's
 * `audience.test.ts`; here we test the registry resolution rules in isolation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerProtectedResource,
  resetProtectedResources,
  resolveProtectedResource,
  listProtectedResourceUris,
} from "../../src/lib/protected-resources.ts";

describe("protected-resource registry", () => {
  beforeEach(() => resetProtectedResources());

  it("resolves an exact prefix and its sub-paths", () => {
    registerProtectedResource("/api/mcp", () => "https://x/api/mcp");
    expect(resolveProtectedResource("/api/mcp")?.uri).toBe("https://x/api/mcp");
    expect(resolveProtectedResource("/api/mcp/anything")?.uri).toBe("https://x/api/mcp");
  });

  it("does not match a path that merely shares a prefix string", () => {
    registerProtectedResource("/api/mcp", () => "https://x/api/mcp");
    // `/api/mcpx` is NOT under `/api/mcp` (boundary is the slash).
    expect(resolveProtectedResource("/api/mcpx")).toBeUndefined();
    expect(resolveProtectedResource("/api/agents")).toBeUndefined();
  });

  it("matches the most specific (longest) prefix first", () => {
    registerProtectedResource("/api", () => "broad");
    registerProtectedResource("/api/mcp", () => "specific");
    expect(resolveProtectedResource("/api/mcp/x")?.uri).toBe("specific");
    expect(resolveProtectedResource("/api/other")?.uri).toBe("broad");
  });

  it("re-registering a prefix replaces it (idempotent across reloads)", () => {
    registerProtectedResource("/api/mcp", () => "v1");
    registerProtectedResource("/api/mcp", () => "v2");
    expect(resolveProtectedResource("/api/mcp")?.uri).toBe("v2");
    expect(listProtectedResourceUris()).toEqual(["v2"]);
  });

  it("reads the URI lazily at resolve time", () => {
    let v = "before";
    registerProtectedResource("/api/mcp", () => v);
    v = "after";
    expect(resolveProtectedResource("/api/mcp")?.uri).toBe("after");
  });

  it("lists every registered resource URI", () => {
    registerProtectedResource("/api/mcp", () => "https://x/api/mcp");
    registerProtectedResource("/api/foo", () => "https://x/api/foo");
    expect(listProtectedResourceUris().sort()).toEqual(["https://x/api/foo", "https://x/api/mcp"]);
  });

  it("is empty after reset", () => {
    registerProtectedResource("/api/mcp", () => "x");
    resetProtectedResources();
    expect(listProtectedResourceUris()).toEqual([]);
    expect(resolveProtectedResource("/api/mcp")).toBeUndefined();
  });
});
