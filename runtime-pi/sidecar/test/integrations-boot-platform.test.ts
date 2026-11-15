// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  bootIntegrations,
  connectPlatformIntegration,
  RemoteMcpError,
} from "../integrations-boot.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { handlerFetch, legacyMcpHandler } from "@appstrate/mcp-transport/testing";

/**
 * An integration bound to the runtime (`server.platformEndpoint`): the sidecar
 * opens the platform's run MCP server with the run token, and reaches no other
 * origin through that client.
 */

const PLATFORM_API_URL = "http://appstrate-api:3000";

const spec = {
  integrationId: "@appstrate/platform",
  namespace: "@appstrate/platform",
  sourceKind: "remote",
  manifest: {
    name: "@appstrate/platform",
    version: "1.0.0",
    server: { platformEndpoint: true, transport: "streamable-http" },
  },
  spawnEnv: {},
  toolAllowlist: ["log"],
} satisfies IntegrationSpawnSpec;

const log: AppstrateToolDefinition = {
  descriptor: { name: "log", inputSchema: { type: "object" } },
  handler: async () => ({ content: [{ type: "text", text: "Logged" }] }),
};

describe("connectPlatformIntegration", () => {
  it("opens {platformApiUrl}/internal/mcp with the run token on every request", async () => {
    const serve = handlerFetch(legacyMcpHandler({ tools: [log] }));
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(String(input), init);
      seen.push({ url: request.url, auth: request.headers.get("authorization") });
      return serve(request);
    }) as typeof fetch;

    const client = await connectPlatformIntegration(spec, {
      platformApiUrl: `${PLATFORM_API_URL}/`,
      runToken: "run-token",
      fetchFn,
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["log"]);
    } finally {
      await client.close();
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url).toBe(`${PLATFORM_API_URL}/internal/mcp`);
      expect(request.auth).toBe("Bearer run-token");
    }
  });

  // A platform call is bounded by the integration clients' per-call timeout:
  // `APPSTRATE_MCP_TOOL_TIMEOUT_MS` when the operator sets it, else the MCP SDK's
  // 60 s default. The agent's calls request progress, so the bound is an idle
  // one; the platform reports none, so it holds from the call's start.
  it("ends a hung tools/call in a timeout error within the per-call bound", async () => {
    const hung: AppstrateToolDefinition = {
      descriptor: { name: "log", inputSchema: { type: "object" } },
      handler: () => new Promise(() => {}),
    };
    const previous = process.env.APPSTRATE_MCP_TOOL_TIMEOUT_MS;
    process.env.APPSTRATE_MCP_TOOL_TIMEOUT_MS = "200";
    let client: Awaited<ReturnType<typeof connectPlatformIntegration>> | undefined;
    try {
      client = await connectPlatformIntegration(spec, {
        platformApiUrl: PLATFORM_API_URL,
        runToken: "run-token",
        fetchFn: handlerFetch(legacyMcpHandler({ tools: [hung] })),
      });
      const startedAt = Date.now();
      const error = await client
        .callTool({ name: "log", arguments: {} }, { onProgress: () => {} })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(error).toBeInstanceOf(RemoteMcpError);
      expect((error as RemoteMcpError).failure).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (previous === undefined) delete process.env.APPSTRATE_MCP_TOOL_TIMEOUT_MS;
      else process.env.APPSTRATE_MCP_TOOL_TIMEOUT_MS = previous;
      await client?.close().catch(() => {});
    }
  });

  it("refuses a request to any other origin, without sending the run token", async () => {
    let sent = 0;
    const fetchFn = (async () => {
      sent += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await expect(
      connectPlatformIntegration(
        spec,
        { platformApiUrl: PLATFORM_API_URL, runToken: "run-token", fetchFn },
        {
          createClient: (async (_url: string | URL, opts?: { fetch?: typeof fetch }) => {
            await opts!.fetch!("https://elsewhere.example.com/mcp", { method: "POST" });
            throw new Error("unreachable");
          }) as never,
        },
      ),
    ).rejects.toThrow(/refusing https:\/\/elsewhere\.example\.com; the run token is not sent/);
    expect(sent).toBe(0);
  });

  it("follows no redirect, even to its own origin", async () => {
    const hits: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const { pathname } = new URL(request.url);
        hits.push(pathname);
        return pathname === "/internal/mcp"
          ? new Response(null, { status: 302, headers: { location: "/moved/mcp" } })
          : new Response(null, { status: 404 });
      },
    });
    try {
      await expect(
        connectPlatformIntegration(
          spec,
          { platformApiUrl: `http://127.0.0.1:${server.port}`, runToken: "run-token" },
          { connectDeadlineMs: 2_000 },
        ),
      ).rejects.toThrow();
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((path) => path === "/internal/mcp")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

describe("bootIntegrations — an integration bound to the runtime", () => {
  it("connects it to {platformApiUrl}/internal/mcp", async () => {
    const serve = handlerFetch(legacyMcpHandler({ tools: [log] }));
    const urls: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(String(input), init);
      urls.push(request.url);
      return serve(request);
    }) as typeof fetch;
    const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
    let result: Awaited<ReturnType<typeof bootIntegrations>> | undefined;
    try {
      result = await bootIntegrations([spec], {
        platformApiUrl: PLATFORM_API_URL,
        runToken: "run-token",
        fetchFn,
      });
      expect(result.report.ok).toBe(true);
      expect(result.tools.map((t) => t.descriptor.name)).toEqual(["appstrate_platform__log"]);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((url) => url === `${PLATFORM_API_URL}/internal/mcp`)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
      await result?.shutdown();
    }
  });
});
