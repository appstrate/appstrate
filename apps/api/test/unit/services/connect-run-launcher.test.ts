// SPDX-License-Identifier: Apache-2.0

/**
 * P4 — connect-run launcher (the production ConnectToolExecutor) unit tests.
 *
 * Drives `createConnectRunExecutor` against a MOCK RunOrchestrator (no
 * Docker, no real sidecar). Asserts:
 *   - the spec it hands `createSidecar` carries CONNECT_LOGIN_JSON-worthy data
 *     (connectLoginSpec + integrations) with the right connectLogin block;
 *   - it parses the `APPSTRATE_CONNECT_RESULT:` sentinel into a CredentialBundle;
 *   - it throws on the `APPSTRATE_CONNECT_ERROR:` sentinel and on timeout;
 *   - it tears down (removeWorkload + removeIsolationBoundary) in `finally`,
 *     even on error.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  registerOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../../src/services/orchestrator/registry.ts";
import type {
  RunOrchestrator,
  IsolationBoundary,
  WorkloadHandle,
  SidecarLaunchSpec,
} from "@appstrate/core/platform-types";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  createConnectRunExecutor,
  buildConnectLoginSpec,
  parseConnectResult,
  type McpServerResolver,
} from "../../../src/services/connect/connect-run-launcher.ts";
import type { ConnectToolExecution } from "../../../src/services/connect/orchestrated-strategy.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  connectToolBlock,
} from "../../helpers/integration-manifests.ts";

beforeAll(() => {
  process.env.RUN_TOKEN_SECRET = process.env.RUN_TOKEN_SECRET ?? "connect-run-test-secret";
});

const MANIFEST: IntegrationManifest = localIntegrationManifest({
  name: "@scope/connect-it",
  auths: {
    session: {
      type: "custom",
      authorizedUris: ["https://api.example.test/**"],
      connect: connectToolBlock({
        tool: "login",
        runAt: "link",
        produces: ["session_token"],
        reauthOn: [401],
      }),
      delivery: httpHeaderDelivery({
        name: "Authorization",
        prefix: "Bearer ",
        field: "session_token",
      }),
    },
  },
});

// The local-source integration references an mcp-server package; the launcher
// resolves its runnable server config. Injected here so the unit test needs no DB.
const fakeMcpResolver: McpServerResolver = async () => ({
  ok: true,
  execution: {
    packageId: "@scope/connect-server",
    version: "1.2.3",
    source: "version",
    runtime: "python",
    entryPoint: "./server.py",
    manifest: {
      manifest_version: "0.3",
      name: "@scope/connect-server",
      version: "1.2.3",
      type: "mcp-server",
      schema_version: "0.1",
      server: { type: "python", entry_point: "./server.py" },
    } as never,
  },
});

/**
 * Mirror of the sidecar's result-channel encryption
 * (`runtime-pi/sidecar/server.ts`): AES-256-GCM, wire =
 * base64(iv‖authTag‖ciphertext). Lets the tests build the ciphertext the
 * launcher's `parseConnectResult` decrypts.
 */
function encryptConnectResult(bundle: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function execution(): ConnectToolExecution {
  return {
    scope: { orgId: "o", applicationId: "a" },
    actor: { type: "user", id: "u" },
    integrationId: "@scope/connect-it",
    authKey: "session",
    manifest: MANIFEST,
    toolName: "login",
    produces: ["session_token"],
    inputs: { email: "a@b.c", password: "pw" },
    inputFields: ["email", "password"],
  };
}

interface MockCalls {
  createdBoundaries: string[];
  sidecarSpecs: SidecarLaunchSpec[];
  started: number;
  removedWorkloads: number;
  removedBoundaries: number;
}

/**
 * Build a mock orchestrator that yields `stdoutLines` and exits with
 * `exitCode`. When `resultBundle` is set, the mock captures the
 * `connectResultKey` the launcher passes to `createSidecar` and emits a REAL
 * encrypted `APPSTRATE_CONNECT_RESULT:` sentinel for it (exercising the
 * encrypt→decrypt round-trip). When `hang` is true, `waitForExit` never
 * resolves (drives the timeout path) until `stopWorkload` is called.
 */
function mockOrchestrator(opts: {
  stdoutLines?: string[];
  resultBundle?: unknown;
  exitCode?: number;
  hang?: boolean;
}): {
  orch: RunOrchestrator;
  calls: MockCalls;
} {
  const calls: MockCalls = {
    createdBoundaries: [],
    sidecarSpecs: [],
    started: 0,
    removedWorkloads: 0,
    removedBoundaries: 0,
  };
  let stopped = false;
  let capturedResultKey: Buffer | undefined;

  const orch: Partial<RunOrchestrator> = {
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      calls.createdBoundaries.push(runId);
      return {
        id: `net-${runId}`,
        name: `net-${runId}`,
        workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
        sidecarEndpoints: {
          sidecarUrl: "http://sidecar:8080",
          llmProxyUrl: "http://sidecar:8080/llm",
          forwardProxyUrl: "http://sidecar:8081",
          noProxy: "sidecar,localhost,127.0.0.1",
        },
      };
    },
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      spec: SidecarLaunchSpec,
    ): Promise<WorkloadHandle> {
      calls.sidecarSpecs.push(spec);
      if (spec.connectResultKey) {
        capturedResultKey = Buffer.from(spec.connectResultKey, "base64");
      }
      return { id: `sc-${runId}`, runId, role: "sidecar" };
    },
    async startWorkload(): Promise<void> {
      calls.started += 1;
    },
    async stopWorkload(): Promise<void> {
      stopped = true;
    },
    async removeWorkload(): Promise<void> {
      calls.removedWorkloads += 1;
    },
    async removeIsolationBoundary(): Promise<void> {
      calls.removedBoundaries += 1;
    },
    async waitForExit(): Promise<number> {
      if (opts.hang) {
        // Resolve only once stopWorkload (timeout) fired.
        await new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            if (stopped) {
              clearInterval(tick);
              resolve();
            }
          }, 5);
        });
        return 137;
      }
      return opts.exitCode ?? 0;
    },
    async *streamLogs(): AsyncGenerator<string> {
      // Emit the encrypted result sentinel keyed by the launcher-supplied
      // connectResultKey (captured in createSidecar) so the round-trip is real.
      if (opts.resultBundle !== undefined && capturedResultKey) {
        yield `APPSTRATE_CONNECT_RESULT:${encryptConnectResult(opts.resultBundle, capturedResultKey)}`;
      }
      for (const line of opts.stdoutLines ?? []) yield line;
    },
  };

  return { orch: orch as RunOrchestrator, calls };
}

describe("buildConnectLoginSpec", () => {
  it("derives the connectLogin block from the manifest auth + resolved mcp-server", async () => {
    const spec = await buildConnectLoginSpec(execution(), fakeMcpResolver);
    expect(spec.integrationId).toBe("@scope/connect-it");
    expect(spec.toolAllowlist).toEqual([]);
    // The runnable server config comes from the referenced mcp-server package.
    expect(spec.manifest.server).toEqual({
      type: "python",
      entry_point: "./server.py",
      packageId: "@scope/connect-server",
      version: "1.2.3",
    });
    expect(spec.connectLogin).toBeDefined();
    expect(spec.connectLogin!).toMatchObject({
      toolName: "login",
      produces: ["session_token"],
      authKey: "session",
      authType: "custom",
      authorizedUris: ["https://api.example.test/**"],
      inputs: { email: "a@b.c", password: "pw" },
      reauthOn: [401],
    });
    // AFPS delivery.http shape (snake_case header block).
    expect(spec.connectLogin!.deliveryHttp).toMatchObject({
      in: "header",
      name: "Authorization",
      prefix: "Bearer ",
      value: "{$credential.session_token}",
    });
    // Placeholder MITM auth so the sidecar wires the listener + source.
    expect(spec.httpDeliveryAuths?.session).toBeDefined();
  });

  it("throws when the auth has no delivery.http", async () => {
    const ex = execution();
    const noHttp = JSON.parse(JSON.stringify(MANIFEST)) as IntegrationManifest;
    delete (noHttp.auths!.session as { delivery?: unknown }).delivery;
    ex.manifest = noHttp;
    await expect(buildConnectLoginSpec(ex, fakeMcpResolver)).rejects.toThrow(/no delivery.http/);
  });

  it("throws when the integration is not a local source (no spawnable server)", async () => {
    const ex = execution();
    const remote = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
    remote.source = {
      kind: "remote",
      remote: { url: "https://x/mcp", transport: "streamable-http" },
    };
    ex.manifest = remote as unknown as IntegrationManifest;
    await expect(buildConnectLoginSpec(ex, fakeMcpResolver)).rejects.toThrow(/no spawnable server/);
  });

  it("throws when the referenced mcp-server cannot be resolved", async () => {
    const ex = execution();
    const missing: McpServerResolver = async () => ({ ok: false, reason: "not_found" });
    await expect(buildConnectLoginSpec(ex, missing)).rejects.toThrow(/mcp-server/);
  });

  it("does not silently drop a declared browser capability on the secret-blind path", async () => {
    const browserServer: McpServerResolver = async () => {
      const base = await fakeMcpResolver("@scope/connect-server", "o");
      if (!base.ok) return base;
      return {
        ok: true,
        execution: {
          ...base.execution,
          browser: {
            purpose: "automation",
            protocol: "cdp-v1",
            profile: "standard",
            allowedOrigins: ["https://example.com"],
            sessionMode: "none",
            trustedDriver: false,
          },
        },
      };
    };
    await expect(buildConnectLoginSpec(execution(), browserServer)).rejects.toThrow(
      /explicit trusted browser executor marker/,
    );
  });
});

describe("parseConnectResult", () => {
  const KEY = randomBytes(32);

  it("decrypts the result sentinel into a CredentialBundle", () => {
    const bundle = { outputs: { session_token: "sess-1" }, expiresAt: null };
    const out = parseConnectResult(
      ["boot log", `APPSTRATE_CONNECT_RESULT:${encryptConnectResult(bundle, KEY)}`],
      KEY,
    );
    expect(out.outputs.session_token).toBe("sess-1");
  });

  it("throws on the error sentinel", () => {
    expect(() => parseConnectResult(["APPSTRATE_CONNECT_ERROR:login tool 500"], KEY)).toThrow(
      /connect-run failed: login tool 500/,
    );
  });

  it("throws when no sentinel was emitted", () => {
    expect(() => parseConnectResult(["just boot logs", "more logs"], KEY)).toThrow(
      /without emitting a result/,
    );
  });

  it("throws when the result sentinel cannot be decrypted (wrong key)", () => {
    const bundle = { outputs: { session_token: "sess-1" }, expiresAt: null };
    const line = `APPSTRATE_CONNECT_RESULT:${encryptConnectResult(bundle, KEY)}`;
    expect(() => parseConnectResult([line], randomBytes(32))).toThrow(/could not be decrypted/);
  });

  it("throws on invalid ciphertext framing", () => {
    expect(() => parseConnectResult(["APPSTRATE_CONNECT_RESULT:not-base64-payload"], KEY)).toThrow(
      /could not be decrypted/,
    );
  });

  it("throws on valid ciphertext wrapping invalid JSON", () => {
    // Encrypt a non-JSON plaintext under the right key: decrypt succeeds, JSON.parse fails.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, iv);
    const ct = Buffer.concat([cipher.update("{not json}", "utf8"), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
    expect(() => parseConnectResult([`APPSTRATE_CONNECT_RESULT:${payload}`], KEY)).toThrow(
      /invalid JSON/,
    );
  });
});

describe("createConnectRunExecutor.run", () => {
  it("builds the spec, launches a connect-mode sidecar, and returns the bundle", async () => {
    const bundle = { outputs: { session_token: "sess-1" }, expiresAt: null };
    const { orch, calls } = mockOrchestrator({
      resultBundle: bundle,
      exitCode: 0,
    });
    const executor = createConnectRunExecutor({
      orchestrator: orch,
      resolveMcpServer: fakeMcpResolver,
    });

    const result = await executor.run(execution());

    expect(result.outputs.session_token).toBe("sess-1");
    // The launch spec carries a 32-byte (base64) result-channel key.
    expect(Buffer.from(calls.sidecarSpecs[0]!.connectResultKey!, "base64").length).toBe(32);
    // One boundary + one sidecar, started once.
    expect(calls.createdBoundaries.length).toBe(1);
    expect(calls.sidecarSpecs.length).toBe(1);
    expect(calls.started).toBe(1);
    // The launch spec carries the connect-mode spec on both fields.
    const spec = calls.sidecarSpecs[0]!;
    expect(spec.connectLoginSpec).toBeDefined();
    expect(spec.connectLoginSpec!.connectLogin!.toolName).toBe("login");
    expect(spec.integrations?.length).toBe(1);
    expect(spec.runToken).toContain(".");
    // Teardown ran.
    expect(calls.removedWorkloads).toBe(1);
    expect(calls.removedBoundaries).toBe(1);
  });

  it("throws on the error sentinel and still tears down", async () => {
    const { orch, calls } = mockOrchestrator({
      stdoutLines: ["APPSTRATE_CONNECT_ERROR:upstream rejected the secret"],
      exitCode: 1,
    });
    const executor = createConnectRunExecutor({
      orchestrator: orch,
      resolveMcpServer: fakeMcpResolver,
    });

    await expect(executor.run(execution())).rejects.toThrow(/upstream rejected the secret/);
    expect(calls.removedWorkloads).toBe(1);
    expect(calls.removedBoundaries).toBe(1);
  });

  it("throws on timeout and tears down", async () => {
    const { orch, calls } = mockOrchestrator({ stdoutLines: [], hang: true });
    const executor = createConnectRunExecutor({
      orchestrator: orch,
      timeoutMs: 30,
      resolveMcpServer: fakeMcpResolver,
    });

    await expect(executor.run(execution())).rejects.toThrow(/timed out after 30ms/);
    expect(calls.removedWorkloads).toBe(1);
    expect(calls.removedBoundaries).toBe(1);
  });

  it("fails fast when the global backend cannot run sidecar-only workloads", async () => {
    // No injected orchestrator → the executor gates on the GLOBAL backend
    // capability. A backend that boots its workload through the agent
    // (e.g. a one-shot microVM) cannot run a connect-run (sidecar-only) —
    // it would silently never start, so the executor must refuse up front
    // instead of reporting "sidecar exited without emitting a result".
    const prevAdapter = process.env.RUN_ADAPTER;
    process.env.RUN_ADAPTER = "fake-vm";
    registerOrchestrator(
      "fake-vm",
      {
        isolatesWorkloads: true,
        supportsSidecarOnly: false,
        create: () => ({}) as never,
      },
      "test",
    );
    _resetCacheForTesting();
    try {
      const executor = createConnectRunExecutor({ resolveMcpServer: fakeMcpResolver });
      await expect(executor.run(execution())).rejects.toThrow(
        /connect-runs are not supported with RUN_ADAPTER="fake-vm"/,
      );
    } finally {
      if (prevAdapter === undefined) delete process.env.RUN_ADAPTER;
      else process.env.RUN_ADAPTER = prevAdapter;
      _resetOrchestratorRegistryForTesting();
      _resetCacheForTesting();
    }
  });
});
