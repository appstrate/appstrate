// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the mcp-server `_meta` accessors.
 *
 * AFPS (§3.4 / §11.2) lifted mcp-server identity (`name`, `type`,
 * `schema_version`, `dependencies`) from `_meta["dev.afps/mcp-server"]` to
 * the manifest root, so the previous `getMcpServerAfpsName` helper is gone.
 * The vendor extension under `_meta["dev.appstrate/mcp-server"]` (runtime
 * override) is unchanged.
 */

import { describe, it, expect } from "bun:test";
import {
  getMcpServerBrowserCapability,
  getMcpServerRuntime,
  getMcpServerWorkspaceMount,
  mcpServerManifestSchema,
  MCP_SERVER_APPSTRATE_META_KEY,
  MCP_SERVER_WORKSPACE_META_KEY,
  type McpServerManifest,
} from "../src/mcp-server.ts";

function manifest(meta?: Record<string, unknown>): McpServerManifest {
  return {
    manifest_version: "0.3",
    name: "@me/toolkit-server",
    version: "1.0.0",
    type: "mcp-server",
    schema_version: "0.1",
    server: { type: "node", entry_point: "./server.ts" },
    ...(meta ? { _meta: meta } : {}),
  } as unknown as McpServerManifest;
}

function manifestWithUserConfig(userConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "@me/toolkit-server",
    version: "1.0.0",
    type: "mcp-server",
    schema_version: "0.1",
    server: {
      type: "node",
      entry_point: "./server.ts",
      mcp_config: { command: "node", args: ["./server.ts"] },
    },
    user_config: userConfig,
  };
}

// ─────────────────────────────────────────────
// Local refine: user_config MCPB inner shape
// ─────────────────────────────────────────────
//
// Upstream `@afps-spec/schema` types `user_config` as
// `z.record(z.string(), z.unknown())` — any value passes. The local refine in
// `mcp-server.ts` validates each entry against the MCPB inner shape.
describe("mcpServerManifestSchema — user_config MCPB inner shape (local refine)", () => {
  it("accepts a well-formed user_config entry", () => {
    const r = mcpServerManifestSchema.safeParse(
      manifestWithUserConfig({ foo: { type: "string", title: "Foo" } }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects a user_config entry missing the required `type` field", () => {
    const r = mcpServerManifestSchema.safeParse(manifestWithUserConfig({ foo: { title: "Foo" } }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.path[0] === "user_config" && i.path[1] === "foo" && i.path.includes("type"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a user_config entry whose `type` is not in the MCPB enum", () => {
    const r = mcpServerManifestSchema.safeParse(
      manifestWithUserConfig({ foo: { type: "invalid_type", title: "Foo" } }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.path[0] === "user_config" && i.path[1] === "foo" && i.path.includes("type"),
        ),
      ).toBe(true);
    }
  });
});

describe("getMcpServerWorkspaceMount", () => {
  it("returns undefined when _meta.workspace is absent (default: no workspace access)", () => {
    expect(getMcpServerWorkspaceMount(manifest())).toBeUndefined();
    expect(getMcpServerWorkspaceMount(manifest({}))).toBeUndefined();
  });

  it("parses a well-formed entry with rw access", () => {
    const m = manifest({
      [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/workspace", access: "rw" },
    });
    expect(getMcpServerWorkspaceMount(m)).toEqual({ mount: "/workspace", access: "rw" });
  });

  it("defaults access to 'ro' (least-privilege) when omitted", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/data" } });
    expect(getMcpServerWorkspaceMount(m)).toEqual({ mount: "/data", access: "ro" });
  });

  it("defaults mount to '/workspace' when only access is provided", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { access: "rw" } });
    expect(getMcpServerWorkspaceMount(m)).toEqual({ mount: "/workspace", access: "rw" });
  });

  it("rejects an array-shaped entry (must be an object)", () => {
    const m = manifest({
      [MCP_SERVER_WORKSPACE_META_KEY]: [] as unknown as Record<string, unknown>,
    });
    expect(() => getMcpServerWorkspaceMount(m)).toThrow(/expected object/);
  });

  it("rejects a non-absolute mount path", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "workspace" } });
    expect(() => getMcpServerWorkspaceMount(m)).toThrow(/absolute POSIX path/);
  });

  it("rejects a mount containing a `..` traversal segment", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/work/../etc" } });
    expect(() => getMcpServerWorkspaceMount(m)).toThrow(/path-traversal/);
  });

  it("rejects a mount containing nested `..` smuggled past a literal-segment check", () => {
    // `/work/foo/./../../etc` does NOT contain a top-level `..`
    // segment when split naively — but the normaliser collapses
    // `./` and reveals the `..` so the downstream check fires.
    const m = manifest({
      [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/work/foo/./../../etc" },
    });
    expect(() => getMcpServerWorkspaceMount(m)).toThrow(/path-traversal/);
  });

  it("normalises redundant `./` + trailing slashes without false-rejecting", () => {
    const m = manifest({
      [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/workspace/./sub//", access: "rw" },
    });
    expect(getMcpServerWorkspaceMount(m)).toEqual({
      mount: "/workspace/sub",
      access: "rw",
    });
  });

  it("rejects a mount with control characters (NUL, newline, CR, tab)", () => {
    for (const bad of ["/workspace\x00", "/workspace\n", "/workspace\r/sub", "/work\tspace"]) {
      const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: bad } });
      expect(() => getMcpServerWorkspaceMount(m)).toThrow(/control characters/);
    }
  });

  it("rejects a mount under a kernel-managed prefix", () => {
    for (const mount of ["/proc/self", "/sys/kernel", "/dev/null", "/etc/foo"]) {
      const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount } });
      expect(() => getMcpServerWorkspaceMount(m)).toThrow(/kernel-managed/);
    }
  });

  it("rejects an invalid access value", () => {
    const m = manifest({
      [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/workspace", access: "admin" },
    });
    expect(() => getMcpServerWorkspaceMount(m)).toThrow(/access.*ro.*rw/);
  });

  it("rejects a root mount target (including paths that canonicalise to '/')", () => {
    for (const mount of ["/", "//", "/.", "/./"]) {
      const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount } });
      expect(() => getMcpServerWorkspaceMount(m)).toThrow(/root/);
    }
  });

  it("rejects a non-string mount instead of silently coercing to the default", () => {
    for (const mount of [42, ["/data"], {}, ""]) {
      const m = manifest({
        [MCP_SERVER_WORKSPACE_META_KEY]: { mount: mount as unknown as string },
      });
      expect(() => getMcpServerWorkspaceMount(m)).toThrow(/non-empty string/);
    }
  });
});

describe("mcpServerManifestSchema — _meta.workspace install-time validation", () => {
  it("accepts a manifest with a valid workspace declaration", () => {
    const m = {
      ...manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/workspace", access: "rw" } }),
      server: {
        type: "node",
        entry_point: "./server.ts",
        mcp_config: { command: "node", args: ["./server.ts"] },
      },
    };
    const r = mcpServerManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
  });

  it("rejects a manifest with a malformed workspace declaration at install time", () => {
    const m = {
      ...manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "../escape" } }),
      server: {
        type: "node",
        entry_point: "./server.ts",
        mcp_config: { command: "node", args: ["./server.ts"] },
      },
    };
    const r = mcpServerManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.path[0] === "_meta" && i.path[1] === MCP_SERVER_WORKSPACE_META_KEY,
        ),
      ).toBe(true);
    }
  });
});

describe("getMcpServerRuntime", () => {
  it("reads the runtime override from _meta['dev.appstrate/mcp-server'].runtime", () => {
    const m = manifest({ "dev.appstrate/mcp-server": { runtime: "bun" } });
    expect(getMcpServerRuntime(m)).toBe("bun");
  });

  it("returns undefined when no override is declared (caller falls back to server.type)", () => {
    expect(getMcpServerRuntime(manifest())).toBeUndefined();
    expect(getMcpServerRuntime(manifest({ "dev.appstrate/mcp-server": {} }))).toBeUndefined();
    expect(
      getMcpServerRuntime(manifest({ "dev.appstrate/mcp-server": { runtime: 42 } })),
    ).toBeUndefined();
  });
});

describe("getMcpServerBrowserCapability", () => {
  it("returns undefined when no browser capability is declared", () => {
    expect(getMcpServerBrowserCapability(manifest())).toBeUndefined();
    expect(
      getMcpServerBrowserCapability(
        manifest({ [MCP_SERVER_APPSTRATE_META_KEY]: { runtime: "bun" } }),
      ),
    ).toBeUndefined();
  });

  it("parses, defaults, canonicalizes, and deduplicates exact HTTPS origins", () => {
    const m = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        runtime: "bun",
        capabilities: {
          browser: {
            purpose: "automation",
            origins: ["https://Example.com/", "https://example.com"],
          },
        },
      },
    });

    expect(getMcpServerRuntime(m)).toBe("bun");
    expect(getMcpServerBrowserCapability(m)).toEqual({
      purpose: "automation",
      protocol: "cdp-v1",
      profile: "standard",
      origins: ["https://example.com"],
    });
  });

  it("accepts a strict connection-acquisition declaration", () => {
    const m = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        capabilities: {
          browser: {
            purpose: "connection-acquisition",
            protocol: "cdp-v1",
            profile: "standard",
            origins: ["https://www.leboncoin.fr", "https://auth.leboncoin.fr"],
          },
        },
      },
    });

    expect(getMcpServerBrowserCapability(m)?.purpose).toBe("connection-acquisition");
  });

  it("rejects unsafe, non-origin, wildcard, and credential-bearing URLs", () => {
    const invalidOrigins = [
      "http://example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://metadata.google.internal",
      "https://*.example.com",
      "https://user:secret@example.com",
      "https://example.com/login",
      "https://example.com?token=x",
      "not a URL",
    ];

    for (const origin of invalidOrigins) {
      const m = manifest({
        [MCP_SERVER_APPSTRATE_META_KEY]: {
          capabilities: { browser: { purpose: "automation", origins: [origin] } },
        },
      });
      expect(() => getMcpServerBrowserCapability(m), origin).toThrow();
    }
  });

  it("rejects unknown policy fields instead of silently ignoring them", () => {
    const m = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        capabilities: {
          browser: {
            purpose: "automation",
            origins: ["https://example.com"],
            allowDirectEgress: true,
          },
        },
      },
    });
    expect(() => getMcpServerBrowserCapability(m)).toThrow(/Unrecognized key/);
  });
});

describe("mcpServerManifestSchema — browser capability install-time validation", () => {
  it("accepts a valid browser capability", () => {
    const m = {
      ...manifest({
        [MCP_SERVER_APPSTRATE_META_KEY]: {
          capabilities: {
            browser: {
              purpose: "automation",
              origins: ["https://example.com"],
            },
          },
        },
      }),
      server: {
        type: "node",
        entry_point: "./server.ts",
        mcp_config: { command: "node", args: ["./server.ts"] },
      },
    };
    expect(mcpServerManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects an unsafe browser origin at package validation time", () => {
    const m = {
      ...manifest({
        [MCP_SERVER_APPSTRATE_META_KEY]: {
          capabilities: {
            browser: {
              purpose: "automation",
              origins: ["http://127.0.0.1"],
            },
          },
        },
      }),
      server: {
        type: "node",
        entry_point: "./server.ts",
        mcp_config: { command: "node", args: ["./server.ts"] },
      },
    };
    const parsed = mcpServerManifestSchema.safeParse(m);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) =>
            issue.path[0] === "_meta" &&
            issue.path[1] === MCP_SERVER_APPSTRATE_META_KEY &&
            issue.path.includes("browser"),
        ),
      ).toBe(true);
    }
  });
});
