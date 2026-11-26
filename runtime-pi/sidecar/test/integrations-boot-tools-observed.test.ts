// SPDX-License-Identifier: Apache-2.0

/**
 * The tools-observed report is best-effort: a platform that refuses it (400) or cannot be
 * reached leaves the integration registered and the boot report intact. Driven through
 * `bootIntegrations` against a fake remote MCP server behind a stubbed `fetchFn`; retry pauses
 * are 0 ms. The boot awaits its reports, so they have landed when it returns. Retry counts are
 * pinned in integration-credentials-source.test.ts.
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
import { noCallReporter } from "./helpers/call-journal.ts";

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

const remoteServer = (upstreamTools: AppstrateToolDefinition[]) =>
  handlerFetch(modernMcpHandler({ tools: upstreamTools }));

/** Boots with `serve` answering everything but the report, which `observed` answers. */
async function bootWith(
  spec: IntegrationSpawnSpec,
  serve: (request: Request) => Response | Promise<Response>,
  observed: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
) {
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
      callReporter: noCallReporter,
      fetchFn,
      retryDelayMs: noDelay,
    });
    const toolNames = result.tools.map((t) => t.descriptor.name);
    await result.shutdown();
    return { toolNames, report: result.report, reports };
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("bootIntegrations — tools-observed report", () => {
  for (const [label, answer] of [
    ["rejects", () => Promise.reject(new Error("network down"))],
    ["answers 400", () => new Response("{}", { status: 400 })],
  ] as const) {
    it(`keeps the integration registered when the report ${label}`, async () => {
      const { reports, report, toolNames } = await bootWith(
        baseSpec,
        remoteServer([tool("echo")]),
        answer,
      );
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
    const { toolNames, reports } = await bootWith(
      spec,
      remoteServer([tool("echo"), tool("blocked"), tool("secret")]),
    );
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
    const serve = (request: Request) =>
      request.url.includes("/internal/integration-bundle/")
        ? new Response(bundle, { status: 200 })
        : new Response("{}", { status: 404 });
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
    const runnerExec = await installPassthroughRunnerExec();
    try {
      const { toolNames, reports } = await bootWith(spec, serve);
      expect(toolNames).toContain("buntoolkit__uuid");
      expect(toolNames).not.toContain("buntoolkit__hash");
      expect(reports).toEqual([{ unavailable: [{ name: "hash", reason: "blocked_in_space" }] }]);
    } finally {
      await runnerExec.restore();
    }
  });
});
