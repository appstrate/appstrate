// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  MCP_SERVER_APPSTRATE_META_KEY,
  MCP_SERVER_WORKSPACE_META_KEY,
  type McpServerManifest,
} from "@appstrate/core/mcp-server";
import type { McpServerResolution } from "../../../src/services/integration-service.ts";
import { resolveLocalMcpServerExecution } from "../../../src/services/resolved-mcp-server-execution.ts";

function manifest(meta?: Record<string, unknown>): McpServerManifest {
  return {
    manifest_version: "0.3",
    name: "@appstrate/browser-driver",
    version: "1.4.0",
    type: "mcp-server",
    schema_version: "0.1",
    server: { type: "node", entry_point: "./server.js" },
    ...(meta ? { _meta: meta } : {}),
  } as McpServerManifest;
}

describe("resolveLocalMcpServerExecution", () => {
  it("returns resolution failures without applying partial policy", async () => {
    const result = await resolveLocalMcpServerExecution(
      { packageId: "@appstrate/missing", orgId: "org" },
      async () => ({ ok: false, reason: "not_found" }),
      () => {
        throw new Error("must not authorize");
      },
    );

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("normalizes version, runtime override, workspace, and browser once", async () => {
    const resolvedManifest = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        runtime: "bun",
        capabilities: {
          browser: {
            purpose: "connection-acquisition",
            protocol: "cdp-v1",
            profile: "standard",
            origins: ["https://auth.example.com"],
          },
        },
      },
      [MCP_SERVER_WORKSPACE_META_KEY]: { mount: "/work", access: "ro" },
    });
    const resolver = async (): Promise<McpServerResolution> => ({
      ok: true,
      manifest: resolvedManifest,
      version: "1.3.2",
      source: "version",
    });

    const result = await resolveLocalMcpServerExecution(
      {
        packageId: "@appstrate/browser-driver",
        orgId: "org",
        pin: "^1.0.0",
        sessionMode: "exportable",
        connectionId: "connection-1",
      },
      resolver,
      (input) => {
        expect(input.version).toBe("1.3.2");
        expect(input.source).toBe("version");
        return { trustedDriver: true, driverGrantId: "system-driver" };
      },
    );

    expect(result).toEqual({
      ok: true,
      execution: {
        packageId: "@appstrate/browser-driver",
        version: "1.3.2",
        source: "version",
        runtime: "bun",
        entryPoint: "./server.js",
        manifest: resolvedManifest,
        workspaceMount: { mount: "/work", access: "ro" },
        browser: {
          purpose: "connection-acquisition",
          protocol: "cdp-v1",
          profile: "standard",
          allowedOrigins: ["https://auth.example.com"],
          sessionMode: "exportable",
          trustedDriver: true,
          driverGrantId: "system-driver",
          connectionId: "connection-1",
        },
      },
    });
  });

  it("keeps ordinary automation untrusted and sessionless", async () => {
    const resolvedManifest = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        capabilities: {
          browser: {
            purpose: "automation",
            protocol: "cdp-v1",
            profile: "standard",
            origins: ["https://example.com"],
          },
        },
      },
    });

    const result = await resolveLocalMcpServerExecution(
      { packageId: "@appstrate/browser-driver", orgId: "org" },
      async () => ({
        ok: true,
        manifest: resolvedManifest,
        version: null,
        source: "system",
      }),
      () => ({ trustedDriver: false }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.execution.version).toBe("1.4.0");
      expect(result.execution.browser).toMatchObject({
        purpose: "automation",
        sessionMode: "none",
        trustedDriver: false,
      });
    }
  });

  it("allows the browser-use runtime only for system browser packages", async () => {
    const resolvedManifest = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: {
        runtime: "browser-use",
        capabilities: {
          browser: {
            purpose: "automation",
            protocol: "cdp-v1",
            profile: "standard",
            origins: ["https://example.com"],
          },
        },
      },
    });

    await expect(
      resolveLocalMcpServerExecution(
        { packageId: "@appstrate/browser-driver", orgId: "org" },
        async () => ({
          ok: true,
          manifest: resolvedManifest,
          version: "1.4.0",
          source: "version",
        }),
        () => ({ trustedDriver: false }),
      ),
    ).rejects.toThrow(/browser-use runtime is restricted to system browser packages/);

    const systemResult = await resolveLocalMcpServerExecution(
      { packageId: "@appstrate/browser-driver", orgId: "org" },
      async () => ({
        ok: true,
        manifest: resolvedManifest,
        version: null,
        source: "system",
      }),
      () => ({ trustedDriver: false }),
    );

    expect(systemResult.ok).toBe(true);
    if (systemResult.ok) expect(systemResult.execution.runtime).toBe("browser-use");
  });

  it("refuses the browser-use runtime without a browser capability", async () => {
    const resolvedManifest = manifest({
      [MCP_SERVER_APPSTRATE_META_KEY]: { runtime: "browser-use" },
    });

    await expect(
      resolveLocalMcpServerExecution(
        { packageId: "@appstrate/browser-driver", orgId: "org" },
        async () => ({
          ok: true,
          manifest: resolvedManifest,
          version: null,
          source: "system",
        }),
      ),
    ).rejects.toThrow(/browser-use runtime is restricted to system browser packages/);
  });
});
