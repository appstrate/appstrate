// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Phase 4 §D4.2 manifest extension.
 *
 * These exercise both the cheap type guard
 * ({@link isMcpServerManifestDefinition}) and the strict parser
 * ({@link parseMcpServerManifest}). The loader's spawn behaviour is
 * covered separately in `loader.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  MCP_SERVER_RUNTIME,
  isMcpServerManifestDefinition,
  parseMcpServerManifest,
} from "../src/index.ts";

describe("isMcpServerManifestDefinition", () => {
  it("returns true for a definition with the discriminator", () => {
    expect(isMcpServerManifestDefinition({ runtime: "mcp-server" })).toBe(true);
  });

  it("returns false for the legacy in-process definition", () => {
    expect(isMcpServerManifestDefinition({ entrypoint: "./tool.js" })).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isMcpServerManifestDefinition(null)).toBe(false);
    expect(isMcpServerManifestDefinition("mcp-server")).toBe(false);
    expect(isMcpServerManifestDefinition(undefined)).toBe(false);
  });
});

describe("parseMcpServerManifest", () => {
  it("applies defaults on a minimal valid definition", () => {
    const out = parseMcpServerManifest({
      runtime: MCP_SERVER_RUNTIME,
      entrypoint: "./server.js",
    });
    expect(out).toEqual({
      runtime: "mcp-server",
      entrypoint: "./server.js",
      args: [],
      transport: "stdio",
      envAllowList: [],
      trustLevel: "third-party",
      initTimeoutMs: 30_000,
    });
  });

  it("preserves optional fields when supplied", () => {
    const out = parseMcpServerManifest({
      runtime: MCP_SERVER_RUNTIME,
      entrypoint: "./bin/server",
      args: ["--port", "0"],
      transport: "stdio",
      envAllowList: ["NOTION_TOKEN", "API_KEY"],
      trustLevel: "first-party",
      initTimeoutMs: 60_000,
    });
    expect(out.args).toEqual(["--port", "0"]);
    expect(out.envAllowList).toEqual(["NOTION_TOKEN", "API_KEY"]);
    expect(out.trustLevel).toBe("first-party");
    expect(out.initTimeoutMs).toBe(60_000);
  });

  it("rejects entries outside the manifest grammar", () => {
    expect(() => parseMcpServerManifest({ runtime: "not-mcp-server" })).toThrow(/runtime/);
    expect(() => parseMcpServerManifest({ runtime: MCP_SERVER_RUNTIME, entrypoint: "" })).toThrow(
      /entrypoint/,
    );
    expect(() =>
      parseMcpServerManifest({ runtime: MCP_SERVER_RUNTIME, entrypoint: "../escape" }),
    ).toThrow(/path traversal/);
  });

  it("rejects non-stdio transports (HTTP/SSE deferred per D4.1)", () => {
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        transport: "http",
      }),
    ).toThrow(/transport/);
  });

  it("rejects malformed envAllowList entries", () => {
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        envAllowList: ["lower_case"],
      }),
    ).toThrow(/envAllowList/);
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        envAllowList: ["A".repeat(65)],
      }),
    ).toThrow(/envAllowList/);
  });

  it("caps envAllowList size to defeat blob-list manifests", () => {
    const allowList = Array.from({ length: 33 }, (_, i) => `VAR_${i}`);
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        envAllowList: allowList,
      }),
    ).toThrow(/envAllowList/);
  });

  it("rejects unknown keys (typo defence)", () => {
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        // typo: trustleVel
        trustleVel: "first-party",
      }),
    ).toThrow(/unknown key/);
  });

  it("clamps initTimeoutMs to a sane window", () => {
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        initTimeoutMs: 100,
      }),
    ).toThrow(/initTimeoutMs/);
    expect(() =>
      parseMcpServerManifest({
        runtime: MCP_SERVER_RUNTIME,
        entrypoint: "./s",
        initTimeoutMs: 600_000,
      }),
    ).toThrow(/initTimeoutMs/);
  });
});
