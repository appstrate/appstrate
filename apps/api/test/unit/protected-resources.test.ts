// SPDX-License-Identifier: Apache-2.0

/**
 * Protected-resource registry primitives (`protected-resources.ts`). The
 * middleware behaviour is covered end-to-end in the mcp module's
 * `audience.test.ts`; here we test the registry resolution rules in isolation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerProtectedResource,
  registerProtectedResourceFamily,
  resetProtectedResources,
  resolveProtectedResource,
  isProtectedResourceUri,
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
    expect(isProtectedResourceUri("v2")).toBe(true);
    expect(isProtectedResourceUri("v1")).toBe(false);
  });

  it("reads the URI lazily at resolve time", () => {
    let v = "before";
    registerProtectedResource("/api/mcp", () => v);
    v = "after";
    expect(resolveProtectedResource("/api/mcp")?.uri).toBe("after");
  });

  it("recognises every registered static resource URI", () => {
    registerProtectedResource("/api/mcp", () => "https://x/api/mcp");
    registerProtectedResource("/api/foo", () => "https://x/api/foo");
    expect(isProtectedResourceUri("https://x/api/mcp")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/foo")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/bar")).toBe(false);
  });

  it("resolves a dynamic family by deriving the URI from the path", () => {
    registerProtectedResourceFamily({
      prefix: "/api/mcp/o",
      deriveUri: (path) => {
        const id = path.slice("/api/mcp/o/".length);
        return id && !id.includes("/") ? `https://x/api/mcp/o/${id}` : undefined;
      },
      ownsUri: (uri) => uri.startsWith("https://x/api/mcp/o/"),
    });
    // A concrete org path resolves to its derived URI...
    expect(resolveProtectedResource("/api/mcp/o/acme")?.uri).toBe("https://x/api/mcp/o/acme");
    // ...but the family's bare prefix (no org segment) does not.
    expect(resolveProtectedResource("/api/mcp/o")).toBeUndefined();
    expect(resolveProtectedResource("/api/mcp/o/")).toBeUndefined();
    // `isProtectedResourceUri` matches the family's owned URIs + rejects others.
    expect(isProtectedResourceUri("https://x/api/mcp/o/acme")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/mcp/o/globex")).toBe(true);
    expect(isProtectedResourceUri("https://x/api/other")).toBe(false);
  });

  it("is empty after reset (static + families)", () => {
    registerProtectedResource("/api/mcp", () => "x");
    registerProtectedResourceFamily({
      prefix: "/api/mcp/o",
      deriveUri: () => "https://x/api/mcp/o/a",
      ownsUri: () => true,
    });
    resetProtectedResources();
    expect(isProtectedResourceUri("x")).toBe(false);
    expect(resolveProtectedResource("/api/mcp")).toBeUndefined();
    expect(resolveProtectedResource("/api/mcp/o/a")).toBeUndefined();
  });
});
