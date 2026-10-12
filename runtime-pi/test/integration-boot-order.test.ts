// SPDX-License-Identifier: Apache-2.0

/**
 * The order the entrypoint talks to the sidecar in, against the real sidecar
 * app: the boot report first, the tool list second.
 *
 * `/mcp` waits for the integration boot only up to a fixed cap, then answers
 * `tools/list` without the integrations still booting; `/integrations/boot-report`
 * waits for the boot itself. An agent that listed its tools first, on a boot
 * slower than the cap, registered no integration tool at all and then read a
 * report saying every integration was ready — a run that "succeeds" while each
 * tool call answers `Tool … not found`.
 */

import { describe, it, expect, afterEach, jest } from "bun:test";
import { createMcpHttpClient, type AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { SIDECAR_AUTH_HEADER, type IntegrationBootReport } from "@appstrate/core/sidecar-types";
import type { RuntimeEventDrainer } from "@appstrate/core/runtime-event-drain";
import { createApp } from "../sidecar/app.ts";
import { buildMcpDirectFactories } from "../mcp/direct.ts";
import { fetchIntegrationBootReport } from "../mcp/integration-boot-report.ts";

const TOKEN = "sidecar-token";
const SIDECAR_BOOT_WAIT_MS = 30_000;
const INTEGRATION_TOOL = "up__search";

const NO_EVENTS: RuntimeEventDrainer = { drain: async () => [] };

const report: IntegrationBootReport = {
  ok: true,
  declaredConnections: 1,
  adapter: "process",
  spawned: [{ integrationId: "@scope/up", namespace: "up", toolCount: 1 }],
  failed: [],
  breadcrumbs: [],
};

/** A sidecar whose integration boot is still running once `/mcp` stopped waiting for it. */
function slowBootSidecar() {
  let tools: AppstrateToolDefinition[] = [];
  let finishBoot!: () => void;
  const boot = new Promise<void>((resolve) => {
    finishBoot = () => {
      tools = [
        {
          descriptor: { name: INTEGRATION_TOOL, inputSchema: { type: "object" } },
          handler: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
        },
      ];
      resolve();
    };
  });
  jest.useFakeTimers();
  const app = createApp({
    config: {
      platformApiUrl: "http://mock:3000",
      runToken: "tok",
      proxyUrl: "",
      sidecarAuthToken: TOKEN,
    },
    cookieJar: new Map(),
    integrationBootPromise: boot,
    integrationBootReportProvider: () => report,
    additionalMcpToolsProvider: () => tools,
  });
  jest.advanceTimersByTime(SIDECAR_BOOT_WAIT_MS + 1);
  jest.useRealTimers();
  const fetchFn = ((input: URL | Request | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "localhost");
    return app.request(new URL(String(input)).pathname, { ...init, headers });
  }) as typeof fetch;
  return { fetchFn, finishBoot };
}

async function registeredToolNames(mcp: Awaited<ReturnType<typeof createMcpHttpClient>>) {
  const factories = await buildMcpDirectFactories({
    mcp,
    runId: "run-1",
    emit: () => {},
    workspace: "/tmp",
    drainer: NO_EVENTS,
  });
  const names: string[] = [];
  const pi = { registerTool: (tool: { name: string }) => names.push(tool.name) } as never;
  for (const factory of factories) factory(pi);
  return names;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("integration tools on a boot slower than the sidecar's /mcp wait", () => {
  it("are all registered once the boot report has been read", async () => {
    const { fetchFn, finishBoot } = slowBootSidecar();
    const mcp = await createMcpHttpClient("http://localhost/mcp", {
      fetch: fetchFn,
      extraHeaders: { [SIDECAR_AUTH_HEADER]: TOKEN },
    });
    try {
      // The hazard itself: the boot is still running and `/mcp` already answers.
      expect(await registeredToolNames(mcp)).not.toContain(INTEGRATION_TOOL);

      setTimeout(finishBoot, 20);
      const result = await fetchIntegrationBootReport("http://localhost", TOKEN, fetchFn);
      expect(result).toEqual({ report });

      expect(await registeredToolNames(mcp)).toContain(INTEGRATION_TOOL);
    } finally {
      await mcp.close();
    }
  });
});
