// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { connectPlatformIntegration } from "../integrations-boot.ts";
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
});
