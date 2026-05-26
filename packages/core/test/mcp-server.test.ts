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
import { getMcpServerRuntime, type McpServerManifest } from "../src/mcp-server.ts";

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
