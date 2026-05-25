// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the mcp-server `_meta` accessors:
 *   - `getMcpServerAfpsName` — scoped AFPS identity (`dev.afps/mcp-server`).
 *   - `getMcpServerRuntime` — Appstrate runtime override (`dev.appstrate/mcp-server`).
 * Pure functions, no DB/network.
 */

import { describe, it, expect } from "bun:test";
import {
  getMcpServerAfpsName,
  getMcpServerRuntime,
  type McpServerManifest,
} from "../src/mcp-server.ts";

function manifest(meta?: Record<string, unknown>): McpServerManifest {
  return {
    manifest_version: "0.3",
    name: "toolkit-server",
    version: "1.0.0",
    server: { type: "node", entry_point: "./server.ts" },
    ...(meta ? { _meta: meta } : {}),
  } as unknown as McpServerManifest;
}

describe("getMcpServerAfpsName", () => {
  it("reads the scoped identity from _meta['dev.afps/mcp-server'].name", () => {
    const m = manifest({
      "dev.afps/mcp-server": { name: "@me/toolkit-server", type: "mcp-server" },
    });
    expect(getMcpServerAfpsName(m)).toBe("@me/toolkit-server");
  });

  it("returns undefined when the _meta identity is absent", () => {
    expect(getMcpServerAfpsName(manifest())).toBeUndefined();
    expect(getMcpServerAfpsName(manifest({ "dev.afps/mcp-server": {} }))).toBeUndefined();
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
