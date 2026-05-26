// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the mcp-server `_meta` accessors.
 *
 * AFPS 2.0.2 (§3.4 / §11.2) lifted mcp-server identity (`name`, `type`,
 * `schema_version`, `dependencies`) from `_meta["dev.afps/mcp-server"]` to
 * the manifest root, so the previous `getMcpServerAfpsName` helper is gone.
 * The vendor extension under `_meta["dev.appstrate/mcp-server"]` (runtime
 * override) is unchanged.
 */

import { describe, it, expect } from "bun:test";
import {
  getMcpServerRuntime,
  mcpServerManifestSchema,
  type McpServerManifest,
} from "../src/mcp-server.ts";

function manifest(meta?: Record<string, unknown>): McpServerManifest {
  return {
    manifest_version: "0.3",
    name: "@me/toolkit-server",
    version: "1.0.0",
    type: "mcp-server",
    schema_version: "2.0",
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
    schema_version: "2.0",
    server: {
      type: "node",
      entry_point: "./server.ts",
      mcp_config: { command: "node", args: ["./server.ts"] },
    },
    user_config: userConfig,
  };
}

// ─────────────────────────────────────────────
// Wave 5 — M2 local refine: user_config MCPB inner shape
// ─────────────────────────────────────────────
//
// Upstream `@afps-spec/schema@2.0.3` types `user_config` as
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
