// SPDX-License-Identifier: Apache-2.0

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";

import type {
  IsolationBoundary,
  RunOrchestrator,
  SidecarLaunchSpec,
  WorkloadHandle,
} from "@appstrate/core/platform-types";
import type { McpServerManifest } from "@appstrate/core/mcp-server";
import { _resetCacheForTesting } from "@appstrate/env";
import { parseConnectWorkloadToken } from "../../../src/lib/connect-workload-token.ts";

import {
  initBrowserCapabilityGrants,
  resetBrowserCapabilityGrantsForTest,
} from "../../../src/services/browser-capability-grants.ts";
import {
  buildBrowserConnectSpec,
  createBrowserConnectRunExecutor,
} from "../../../src/services/connect/browser-run-launcher.ts";
import type { BrowserConnectExecution } from "../../../src/services/connect/browser-strategy.ts";
import {
  localIntegrationManifest,
  connectToolBlock,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

beforeAll(() => {
  process.env.RUN_TOKEN_SECRET = process.env.RUN_TOKEN_SECRET ?? "browser-run-test-secret";
  process.env.BROWSER_ENABLED = "true";
  process.env.BROWSER_CONNECT_ENABLED = "true";
  process.env.BROWSER_WORKER_IMAGE = "browser-worker:test";
  _resetCacheForTesting();
});

beforeEach(() => {
  resetBrowserCapabilityGrantsForTest();
  initBrowserCapabilityGrants([
    {
      id: "official-browser",
      packageId: "@scope/browser-driver",
      versionRange: "^1.0.0",
    },
  ]);
});

const manifest = localIntegrationManifest({
  name: "@scope/browser-integration",
  serverName: "@scope/browser-driver",
  auths: {
    session: {
      type: "custom",
      authorizedUris: ["https://api.example.com/**"],
      connect: connectToolBlock({
        tool: "acquire_session",
        runAt: "link",
        produces: ["cookie", "user_agent"],
        browserExecutor: { sessionMode: "exportable" },
      }),
      delivery: httpHeaderDelivery({ name: "Cookie", field: "cookie" }),
    },
  },
});

function execution(): BrowserConnectExecution {
  return {
    scope: { orgId: "org-1", applicationId: "app-1" },
    actor: { type: "user", id: "user-1" },
    integrationId: "@scope/browser-integration",
    authKey: "session",
    manifest,
    toolName: "acquire_session",
    produces: ["cookie", "user_agent"],
    sessionMode: "exportable",
    inputs: { email: "user@example.com", password: "canary-secret" },
  };
}

const driverManifest = {
  manifest_version: "0.3",
  name: "@scope/browser-driver",
  version: "1.2.0",
  type: "mcp-server",
  schema_version: "0.1",
  server: {
    type: "node",
    entry_point: "./server.js",
    mcp_config: { command: "node", args: ["./server.js"] },
  },
  _meta: {
    "dev.appstrate/mcp-server": {
      runtime: "bun",
      capabilities: {
        browser: {
          purpose: "connection-acquisition",
          protocol: "cdp-v1",
          profile: "standard",
          origins: ["https://www.example.com", "https://auth.example.com"],
        },
      },
    },
  },
} as McpServerManifest;

const resolveDriver = async () => ({
  ok: true as const,
  manifest: driverManifest,
  version: null,
  source: "system" as const,
});

function encryptedResult(result: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(result)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

describe("buildBrowserConnectSpec", () => {
  it("binds the concrete authorized driver version and keeps bootstrap inputs private", async () => {
    const spec = await buildBrowserConnectSpec(execution(), resolveDriver);
    expect(spec.manifest.server).toMatchObject({
      type: "bun",
      packageId: "@scope/browser-driver",
    });
    expect(spec.manifest.server?.version).toBeUndefined();
    expect(spec.browser).toMatchObject({
      purpose: "connection-acquisition",
      trustedDriver: true,
      driverGrantId: "official-browser",
      sessionMode: "exportable",
    });
    expect(spec.spawnEnv).toEqual({});
    expect(spec.toolAllowlist).toEqual([]);
    expect(spec.hiddenTools).toEqual(["acquire_session"]);
    expect(spec.browserConnect?.inputs).toEqual({
      email: "user@example.com",
      password: "canary-secret",
    });
    expect(spec.connectLogin).toBeUndefined();
  });

  it("fails closed when the concrete driver grant no longer matches", async () => {
    resetBrowserCapabilityGrantsForTest();
    initBrowserCapabilityGrants([]);
    await expect(buildBrowserConnectSpec(execution(), resolveDriver)).rejects.toThrow(
      /no matching operator grant/,
    );
  });

  it("rejects an org-owned driver even when its id and version match a grant", async () => {
    await expect(
      buildBrowserConnectSpec(execution(), async () => ({
        ok: true,
        manifest: driverManifest,
        version: "1.2.0",
        source: "version",
      })),
    ).rejects.toThrow(/restricted to system packages/);
  });

  it("rejects bootstrap values that cannot cross the bounded private channel", async () => {
    await expect(
      buildBrowserConnectSpec({ ...execution(), inputs: { password: undefined } }, resolveDriver),
    ).rejects.toThrow(/not serializable/);
    await expect(
      buildBrowserConnectSpec(
        { ...execution(), inputs: { blob: "x".repeat(262_145) } },
        resolveDriver,
      ),
    ).rejects.toThrow(/private channel limit/);
  });
});

describe("browser connect run executor", () => {
  it("reserves requirements, encrypts the result channel, and always cleans up", async () => {
    const boundaries: Array<{ runId: string; opts: unknown }> = [];
    const sidecarSpecs: SidecarLaunchSpec[] = [];
    let removedWorkload = 0;
    let removedBoundary = 0;
    let resultLine = "";
    let interactionLine = "";
    const forwardedInteractions: string[] = [];
    const boundary: IsolationBoundary = {
      id: "boundary-1",
      name: "boundary-1",
      workspace: { kind: "directory", path: "/tmp/browser-workspace" },
      sidecarEndpoints: {
        sidecarUrl: "http://sidecar:8080",
        llmProxyUrl: "http://sidecar:8080/llm",
        forwardProxyUrl: "http://sidecar:8081",
        noProxy: "sidecar,localhost",
      },
    };
    const handle: WorkloadHandle = { id: "sidecar-1", runId: "connect-1", role: "sidecar" };
    const orchestrator: Partial<RunOrchestrator> = {
      ensureImages: async () => {},
      createIsolationBoundary: async (runId, opts) => {
        boundaries.push({ runId, opts });
        return boundary;
      },
      createSidecar: async (_runId, _boundary, spec) => {
        sidecarSpecs.push(spec);
        const key = Buffer.from(spec.connectResultKey!, "base64");
        interactionLine =
          "APPSTRATE_BROWSER_INTERACTION:" +
          encryptedResult({ url: "https://live.browser-use.com/live/session-id" }, key);
        resultLine =
          "APPSTRATE_CONNECT_RESULT:" +
          encryptedResult(
            {
              outputs: { cookie: "sid=x", user_agent: "Chromium" },
              proof: { kind: "account-page", succeeded: true },
            },
            key,
          );
        return handle;
      },
      startWorkload: async () => {},
      waitForExit: async () => 0,
      streamLogs: async function* () {
        yield interactionLine;
        yield resultLine;
      },
      stopWorkload: async () => {},
      removeWorkload: async () => {
        removedWorkload += 1;
      },
      removeIsolationBoundary: async () => {
        removedBoundary += 1;
      },
    };

    const executor = createBrowserConnectRunExecutor({
      orchestrator: orchestrator as RunOrchestrator,
      resolveMcpServer: resolveDriver,
      timeoutMs: 1_000,
    });
    const result = await executor.run({
      ...execution(),
      onInteractionRequired: ({ url }) => {
        forwardedInteractions.push(url);
      },
    });
    expect(result.proof).toEqual({ kind: "account-page", succeeded: true });
    expect(boundaries[0]?.opts).toMatchObject({
      requirements: {
        capabilities: [{ kind: "browser", profile: "standard", instances: 1 }],
      },
    });
    expect(sidecarSpecs[0]?.browserConnectSpec?.browserConnect?.inputs.password).toBe(
      "canary-secret",
    );
    expect(sidecarSpecs[0]?.connectLoginSpec).toBeUndefined();
    expect(parseConnectWorkloadToken(sidecarSpecs[0]!.runToken)).toMatchObject({
      audience: "internal:mcp-server-bundle",
      orgId: "org-1",
      applicationId: "app-1",
      integrationId: "@scope/browser-integration",
      mcpServerId: "@scope/browser-driver",
      mcpServerVersion: null,
      mcpServerSource: "system",
    });
    expect(removedWorkload).toBe(1);
    expect(removedBoundary).toBe(1);
    expect(forwardedInteractions).toEqual(["https://live.browser-use.com/live/session-id"]);
  });
});
