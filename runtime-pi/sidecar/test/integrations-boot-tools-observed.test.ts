// SPDX-License-Identifier: Apache-2.0

/**
 * The tools-observed report is fire-and-forget: a platform that refuses it (400) or cannot be
 * reached leaves the integration registered and the boot report intact. Driven through
 * `bootIntegrations` against a fake remote MCP server behind a stubbed global `fetch`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { handlerFetch, modernMcpHandler } from "@appstrate/mcp-transport/testing";
import { bootIntegrations } from "../integrations-boot.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";

const SERVER_URL = "https://mcp.example.com/mcp";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const spec = {
  integrationId: "@vendor/remote",
  namespace: "remote",
  sourceKind: "remote",
  manifest: {
    name: "@vendor/remote",
    version: "1.0.0",
    server: { url: SERVER_URL, transport: "streamable-http" },
  },
  toolAllowlist: ["echo", "gone"],
} as unknown as IntegrationSpawnSpec;

const echo: AppstrateToolDefinition = {
  descriptor: { name: "echo", inputSchema: { type: "object" } },
  handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

async function bootWith(observed: () => Response | Promise<Response>, attempts: number) {
  const serve = handlerFetch(modernMcpHandler({ tools: [echo] }));
  const reports: unknown[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(String(input), init);
    if (request.url.includes("/tools-observed")) {
      reports.push(await request.json());
      return observed();
    }
    return serve(request);
  }) as typeof fetch;
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
  try {
    const result = await bootIntegrations([spec], {
      platformApiUrl: "http://platform.local",
      runToken: "run-token",
    });
    // The report is not awaited by the boot: wait for its last attempt, retries included, so none
    // outlives the stubbed fetch.
    const deadline = Date.now() + 5_000;
    while (reports.length < attempts && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { result, reports };
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("bootIntegrations — tools-observed report", () => {
  for (const [label, answer, attempts] of [
    // A network failure is retried twice; a 4xx is not.
    ["rejects", () => Promise.reject(new Error("network down")), 3],
    ["answers 400", () => new Response("{}", { status: 400 }), 1],
  ] as const) {
    it(`keeps the integration registered when the report ${label}`, async () => {
      const { result, reports } = await bootWith(answer, attempts);
      try {
        expect(reports).toHaveLength(attempts);
        expect(reports[0]).toMatchObject({
          truncated: false,
          unavailable: [{ name: "gone", reason: "not_listed" }],
        });
        expect(result.report.ok).toBe(true);
        expect(result.report.spawned).toHaveLength(1);
        expect(result.report.spawned[0]).toMatchObject({
          integrationId: "@vendor/remote",
          unavailableTools: [{ name: "gone", reason: "not_listed" }],
        });
        expect(result.tools.some((t) => t.descriptor.name.endsWith("echo"))).toBe(true);
      } finally {
        await result.shutdown();
      }
    });
  }
});
