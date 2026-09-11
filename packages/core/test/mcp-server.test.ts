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
  effectiveMcpServerType,
  getMcpServerRuntime,
  getMcpServerWorkspaceMount,
  mcpServerManifestSchema,
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

describe("effectiveMcpServerType", () => {
  it("prefers the _meta override over the MCPB server.type", () => {
    // The whole reason the helper exists: `server.type` says `node` because
    // MCPB has no `bun`, and the package still runs under bun.
    const m = manifest({ "dev.appstrate/mcp-server": { runtime: "bun" } });
    expect((m as unknown as { server: { type: string } }).server.type).toBe("node");
    expect(effectiveMcpServerType(m)).toBe("bun");
  });

  it("falls back to the MCPB server.type when no override is declared", () => {
    expect(effectiveMcpServerType(manifest())).toBe("node");
    expect(effectiveMcpServerType(manifest({ "dev.appstrate/mcp-server": {} }))).toBe("node");
  });

  it("falls back to server.type when the override is not a runtime we know", () => {
    // `_meta` is author-controlled jsonb. An unrecognised value is not a
    // runtime, so it must not shadow the MCPB type — a caller that spawned on
    // it would exec an interpreter that does not exist.
    expect(
      effectiveMcpServerType(manifest({ "dev.appstrate/mcp-server": { runtime: "deno" } })),
    ).toBe("node");
    expect(effectiveMcpServerType(manifest({ "dev.appstrate/mcp-server": { runtime: 42 } }))).toBe(
      "node",
    );
  });

  it("returns server.type VERBATIM, unnarrowed", () => {
    // The SPA reads unvalidated DRAFT manifests: an author's typo must reach
    // the view as written rather than vanish. Narrowing this half to
    // `McpServerRuntime` would silently blank the field being edited.
    const draft = { ...manifest(), server: { type: "nodejs", entry_point: "./server.ts" } };
    expect(effectiveMcpServerType(draft as unknown as McpServerManifest)).toBe("nodejs");
  });

  it("is undefined when neither source declares a runtime", () => {
    // Not runnable. Every spawn caller fails closed on this.
    const headless = { ...manifest(), server: { entry_point: "./server.ts" } };
    expect(effectiveMcpServerType(headless as unknown as McpServerManifest)).toBeUndefined();
    const blank = { ...manifest(), server: { type: "  ", entry_point: "./server.ts" } };
    expect(effectiveMcpServerType(blank as unknown as McpServerManifest)).toBeUndefined();
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

  it("rejects an unknown runtime override during manifest validation", () => {
    const r = mcpServerManifestSchema.safeParse({
      ...manifest({ "dev.appstrate/mcp-server": { runtime: "deno" } }),
      server: {
        type: "node",
        entry_point: "./server.ts",
        mcp_config: { command: "node", args: ["./server.ts"] },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) =>
            i.path.join(".") === "_meta.dev.appstrate/mcp-server.runtime" &&
            i.message.includes("node, bun, python, uv, binary"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a runtime override incompatible with server.type", () => {
    const r = mcpServerManifestSchema.safeParse({
      ...manifest({ "dev.appstrate/mcp-server": { runtime: "bun" } }),
      server: {
        type: "python",
        entry_point: "./server.py",
        mcp_config: { command: "python3", args: ["./server.py"] },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((issue) => issue.message)).toContain(
        "Runtime 'bun' requires server.type 'node'.",
      );
    }
  });
});
