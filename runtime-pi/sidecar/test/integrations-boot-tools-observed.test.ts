// SPDX-License-Identifier: Apache-2.0

/**
 * The tools-observed report is best-effort: a platform that refuses it (400) or cannot be
 * reached leaves the integration registered and the boot report intact. Driven through
 * `bootIntegrations` against a fake remote MCP server behind a stubbed `fetchFn`; retry pauses
 * are 0 ms and the pending reports are drained by `shutdown()`, so nothing sleeps or polls.
 *
 * Also pins that the space policy (`blockedTools`, `approvedToolFingerprints`) reaches
 * `host.register`, on the remote and the local path: a gated tool is absent from the booted tools.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { zipArtifact } from "@appstrate/core/zip";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { handlerFetch, modernMcpHandler } from "@appstrate/mcp-transport/testing";
import { bootIntegrations } from "../integrations-boot.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";
import { installPassthroughRunnerExec } from "./helpers/runner-exec.ts";

const SERVER_URL = "https://mcp.example.com/mcp";

const baseSpec = {
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

const tool = (name: string): AppstrateToolDefinition => ({
  descriptor: { name, inputSchema: { type: "object" } },
  handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

const noDelay = () => 0;

/** Boots, snapshots what the agent would see, then shuts down: that drains the reports. */
async function bootWith(
  spec: IntegrationSpawnSpec,
  upstreamTools: AppstrateToolDefinition[],
  observed: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
) {
  const serve = handlerFetch(modernMcpHandler({ tools: upstreamTools }));
  const reports: unknown[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(String(input), init);
    if (request.url.includes("/tools-observed")) {
      reports.push(await request.json());
      return observed();
    }
    return serve(request);
  }) as typeof fetch;
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  const originalFetch = globalThis.fetch;
  process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
  // The remote MCP server and the report both go through the global fetch.
  globalThis.fetch = fetchFn;
  try {
    const result = await bootIntegrations([spec], {
      platformApiUrl: "http://platform.local",
      runToken: "run-token",
      retryDelayMs: noDelay,
    });
    const snapshot = {
      toolNames: result.tools.map((t) => t.descriptor.name),
      report: result.report,
    };
    await result.shutdown();
    return { ...snapshot, reports };
  } finally {
    globalThis.fetch = originalFetch;
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
      const { reports, report, toolNames } = await bootWith(baseSpec, [tool("echo")], answer);
      expect(reports).toHaveLength(attempts);
      expect(reports[0]).toMatchObject({
        truncated: false,
        unavailable: [{ name: "gone", reason: "not_listed" }],
      });
      expect(report.ok).toBe(true);
      expect(report.spawned).toHaveLength(1);
      expect(report.spawned[0]).toMatchObject({
        integrationId: "@vendor/remote",
        unavailableTools: [{ name: "gone", reason: "not_listed" }],
      });
      expect(toolNames.some((name) => name.endsWith("echo"))).toBe(true);
    });
  }
});

describe("bootIntegrations — the space policy reaches the host", () => {
  it("leaves a blocked tool and an unapproved undeclared tool out of a remote integration", async () => {
    const spec = {
      ...baseSpec,
      toolAllowlist: ["echo", "blocked", "secret"],
      blockedTools: ["blocked"],
      approvedToolFingerprints: { secret: ["not-the-fingerprint"] },
    } as unknown as IntegrationSpawnSpec;
    const { toolNames, reports } = await bootWith(spec, [
      tool("echo"),
      tool("blocked"),
      tool("secret"),
    ]);
    expect(toolNames.filter((name) => name.startsWith("remote__"))).toEqual(["remote__echo"]);
    expect(reports[0]).toMatchObject({
      unavailable: expect.arrayContaining([
        { name: "blocked", reason: "blocked_in_space" },
        { name: "secret", reason: "definition_not_approved" },
      ]),
    });
  });

  it("leaves a blocked tool out of a local integration and reports it without tools", async () => {
    const fixtureDir = path.join(import.meta.dir, "fixtures/bun-toolkit");
    const bundle = zipArtifact({
      "manifest.json": new Uint8Array(readFileSync(path.join(fixtureDir, "manifest.json"))),
      "server.ts": new Uint8Array(readFileSync(path.join(fixtureDir, "server.ts"))),
    });
    const reports: Record<string, unknown>[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(String(input), init);
      if (request.url.includes("/tools-observed")) {
        reports.push((await request.json()) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (request.url.includes("/internal/integration-bundle/")) {
        return new Response(bundle, { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const spec = {
      integrationId: "@appstrate/bun-toolkit",
      namespace: "buntoolkit",
      connection: { id: "conn-a", label: "work", accountId: null },
      sourceKind: "local",
      manifest: {
        name: "@appstrate/bun-toolkit",
        version: "1.0.0",
        server: { type: "bun", entry_point: "./server.ts" },
      },
      spawnEnv: {},
      toolAllowlist: ["uuid", "hash"],
      blockedTools: ["hash"],
    } as unknown as IntegrationSpawnSpec;
    const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
    const runnerExec = await installPassthroughRunnerExec();
    try {
      const result = await bootIntegrations([spec], {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn,
        retryDelayMs: noDelay,
      });
      const names = result.tools.map((t) => t.descriptor.name);
      await result.shutdown();
      expect(names).toContain("buntoolkit__uuid");
      expect(names).not.toContain("buntoolkit__hash");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toEqual({ unavailable: [{ name: "hash", reason: "blocked_in_space" }] });
    } finally {
      await runnerExec.restore();
      if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
    }
  });
});
