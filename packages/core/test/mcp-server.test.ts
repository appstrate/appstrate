// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the local MCP server accessors, which read the INTEGRATION manifest
 * (`source.server` + the Appstrate `_meta` keys on the manifest root).
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@afps-spec/schema";
import {
  effectiveMcpServerType,
  getLocalServerEnv,
  getMcpServerRuntime,
  getMcpServerWorkspaceMount,
  MCP_SERVER_WORKSPACE_META_KEY,
} from "../src/mcp-server.ts";
import { integrationManifestSchema } from "../src/integration.ts";

function manifest(
  meta?: Record<string, unknown>,
  server: Record<string, unknown> = {
    type: "node",
    entry_point: "server/index.ts",
    mcp_config: { command: "node", args: ["server/index.ts"] },
  },
): IntegrationManifest {
  return {
    name: "@me/toolkit",
    version: "1.0.0",
    type: "integration",
    schema_version: "0.1",
    source: { kind: "local", server },
    ...(meta ? { _meta: meta } : {}),
  } as unknown as IntegrationManifest;
}

describe("getLocalServerEnv", () => {
  it("returns the literal mcp_config.env entries", () => {
    const m = manifest(undefined, {
      type: "node",
      entry_point: "server/index.ts",
      mcp_config: { command: "node", env: { MODE: "fast", REGION: "eu" } },
    });
    expect(getLocalServerEnv(m)).toEqual({ MODE: "fast", REGION: "eu" });
  });

  it("is empty when mcp_config declares no env", () => {
    expect(getLocalServerEnv(manifest())).toEqual({});
  });

  it("is empty for a non-local source", () => {
    const remote = {
      name: "@me/r",
      type: "integration",
      source: {
        kind: "remote",
        remote: { url: "https://x.test/mcp", transport: "streamable-http" },
      },
    } as unknown as IntegrationManifest;
    expect(getLocalServerEnv(remote)).toEqual({});
  });

  it("skips non-string values instead of coercing them", () => {
    const m = manifest(undefined, {
      type: "node",
      entry_point: "server/index.ts",
      mcp_config: { command: "node", env: { OK: "1", BAD: 2 } },
    });
    expect(getLocalServerEnv(m)).toEqual({ OK: "1" });
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

describe("integrationManifestSchema — local server _meta install-time validation", () => {
  it("accepts a manifest with a valid workspace declaration", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/workspace", access: "rw" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
  });

  it("rejects a manifest with a malformed workspace declaration at install time", () => {
    const m = manifest({ [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "../escape" } });
    const r = integrationManifestSchema.safeParse(m);
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
  it("prefers the _meta override over the source.server.type", () => {
    // The whole reason the helper exists: `server.type` says `node` because
    // the schema has no `bun`, and the package still runs under bun.
    const m = manifest({ "dev.appstrate/mcp-server": { runtime: "bun" } });
    expect((m as unknown as { source: { server: { type: string } } }).source.server.type).toBe(
      "node",
    );
    expect(effectiveMcpServerType(m)).toBe("bun");
  });

  it("falls back to the source.server.type when no override is declared", () => {
    expect(effectiveMcpServerType(manifest())).toBe("node");
    expect(effectiveMcpServerType(manifest({ "dev.appstrate/mcp-server": {} }))).toBe("node");
  });

  it("falls back to server.type when the override is not a runtime we know", () => {
    // `_meta` is author-controlled jsonb. An unrecognised value is not a
    // runtime, so it must not shadow the source.server.type — a caller that spawned on
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
    expect(
      effectiveMcpServerType(
        manifest(undefined, { type: "nodejs", entry_point: "server/index.ts" }),
      ),
    ).toBe("nodejs");
  });

  it("is undefined when neither source declares a runtime", () => {
    // Not runnable. Every spawn caller fails closed on this.
    expect(
      effectiveMcpServerType(manifest(undefined, { entry_point: "server/index.ts" })),
    ).toBeUndefined();
    expect(
      effectiveMcpServerType(manifest(undefined, { type: "  ", entry_point: "server/index.ts" })),
    ).toBeUndefined();
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
    const r = integrationManifestSchema.safeParse(
      manifest({ "dev.appstrate/mcp-server": { runtime: "deno" } }),
    );
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

  it("rejects a runtime override incompatible with source.server.type", () => {
    const r = integrationManifestSchema.safeParse(
      manifest(
        { "dev.appstrate/mcp-server": { runtime: "bun" } },
        {
          type: "python",
          entry_point: "server/main.py",
          mcp_config: { command: "python3", args: ["server/main.py"] },
        },
      ),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((issue) => issue.message)).toContain(
        "Runtime 'bun' requires source.server.type 'node'.",
      );
    }
  });
});
