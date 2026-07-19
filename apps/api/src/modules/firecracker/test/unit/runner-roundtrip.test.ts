// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol round-trip: the REAL RemoteFirecrackerOrchestrator wired to the
 * REAL runner Hono app via dependency-injected fetch — no network, no
 * Linux. A fake RunOrchestrator sits behind the daemon; every call made
 * on the client must come out identical on the fake. This is the test
 * that catches client/server drift the two sides' isolated suites cannot
 * (schema mismatch, route typo, body shape, NDJSON framing).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  CleanupReport,
  IsolationBoundary,
  RunOrchestrator,
  SidecarLaunchSpec,
  StopResult,
  WorkloadHandle,
  WorkloadSpec,
} from "@appstrate/core/platform-types";
import { createRunnerApp, type RunnerOrchestrator } from "../../runner/server.ts";
import { RemoteFirecrackerOrchestrator } from "../../remote-orchestrator.ts";
import { _resetRemoteEnvCacheForTesting } from "../../remote-env.ts";

const TOKEN = "roundtrip-secret-token-0123456789";

const BOUNDARY: IsolationBoundary = {
  id: "fc-run-1",
  name: "fc-run-1",
  workspace: { kind: "directory", path: "/workspace" },
  sidecarEndpoints: {
    sidecarUrl: "http://127.0.0.1:8080",
    llmProxyUrl: "http://127.0.0.1:8080/llm",
    forwardProxyUrl: "http://127.0.0.1:8081",
    noProxy: "10.231.0.2",
  },
};

const HANDLE: WorkloadHandle = { id: "vm-run-1-agent", runId: "run-1", role: "agent" };

function makeFakeOrchestrator(): RunnerOrchestrator & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const record =
    <T>(name: string, ret: T) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return Promise.resolve(ret);
    };
  return {
    calls,
    initialize: record("initialize", undefined),
    shutdown: record("shutdown", undefined),
    cleanupOrphans: record("cleanupOrphans", {
      workloads: 2,
      isolationBoundaries: 1,
      workspaces: 1,
    } satisfies CleanupReport),
    ensureImages: record("ensureImages", undefined),
    createIsolationBoundary: record("createIsolationBoundary", BOUNDARY),
    removeIsolationBoundary: record("removeIsolationBoundary", undefined),
    createSidecar: record("createSidecar", { ...HANDLE, role: "sidecar" }),
    createWorkload: record("createWorkload", HANDLE),
    startWorkload: record("startWorkload", undefined),
    stopWorkload: record("stopWorkload", undefined),
    removeWorkload: record("removeWorkload", undefined),
    waitForExit: record("waitForExit", 42),

    streamLogs: async function* (_handle, _signal) {
      calls.push(["streamLogs", [_handle]]);
      yield "guest line 1";
      yield "guest line 2";
      yield "guest line 3";
    } as RunOrchestrator["streamLogs"],
    stopByRunId: record("stopByRunId", "stopped" satisfies StopResult),
    resolvePlatformApiUrl: record("resolvePlatformApiUrl", "http://192.168.1.10:3000"),
    workloadStatus: (handle) => {
      calls.push(["workloadStatus", [handle]]);
      return { running: true };
    },
    readConsole: (id, tailBytes) => {
      calls.push(["readConsole", [id, tailBytes]]);
      return Promise.resolve(`console:${id}`);
    },
  };
}

function makeClient(fake: RunnerOrchestrator) {
  const app = createRunnerApp({ orchestrator: fake, token: TOKEN, exitLongPollMs: 100 });
  // The client builds absolute URLs from FIRECRACKER_RUNNER_URL;
  // app.request accepts them and routes on the path.
  const fetchFn = ((input: string | URL, init?: RequestInit) =>
    app.request(String(input), init)) as typeof fetch;
  return new RemoteFirecrackerOrchestrator({ fetchFn, retryBaseMs: 1 });
}

describe("runner protocol round-trip (real client ↔ real server)", () => {
  const savedUrl = process.env.FIRECRACKER_RUNNER_URL;
  const savedToken = process.env.FIRECRACKER_RUNNER_TOKEN;

  beforeEach(() => {
    // Loopback on purpose: the P1-5 transport gate refuses plaintext
    // http:// to a non-loopback daemon; the round-trip never leaves the
    // process anyway (fetchFn is the Hono app).
    process.env.FIRECRACKER_RUNNER_URL = "http://127.0.0.1:3100";
    process.env.FIRECRACKER_RUNNER_TOKEN = TOKEN;
    _resetRemoteEnvCacheForTesting();
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.FIRECRACKER_RUNNER_URL;
    else process.env.FIRECRACKER_RUNNER_URL = savedUrl;
    if (savedToken === undefined) delete process.env.FIRECRACKER_RUNNER_TOKEN;
    else process.env.FIRECRACKER_RUNNER_TOKEN = savedToken;
    _resetRemoteEnvCacheForTesting();
  });

  it("initialize() health-checks the daemon end to end", async () => {
    const fake = makeFakeOrchestrator();
    const client = makeClient(fake);
    await client.initialize();
    // The daemon answers health itself — the wrapped orchestrator is not consulted.
    expect(fake.calls.find(([name]) => name === "initialize")).toBeUndefined();
  });

  it("full run lifecycle crosses the wire intact", async () => {
    const fake = makeFakeOrchestrator();
    const client = makeClient(fake);
    await client.initialize();

    const requirements = {
      capabilities: [{ kind: "browser" as const, profile: "standard" as const, instances: 1 }],
      supplementalResources: {
        memoryBytes: 1024 * 1024 * 1024,
        nanoCpus: 1_000_000_000,
        pidsLimit: 256,
      },
    };
    const boundary = await client.createIsolationBoundary("run-1", {
      skipSidecar: false,
      requirements,
    });
    expect(boundary).toEqual(BOUNDARY);
    const boundaryCall = fake.calls.find(([name]) => name === "createIsolationBoundary");
    expect(boundaryCall?.[1]).toEqual(["run-1", { skipSidecar: false, requirements }]);

    const sidecarSpec = {
      runToken: "tok_secret",
      integrations: [{ anything: "loose fields survive" }],
    } as unknown as SidecarLaunchSpec;
    const sidecar = await client.createSidecar("run-1", boundary, sidecarSpec);
    expect(sidecar.role).toBe("sidecar");
    const sidecarCall = fake.calls.find(([name]) => name === "createSidecar");
    expect(sidecarCall?.[1][2]).toEqual(sidecarSpec);

    const spec: WorkloadSpec = {
      runId: "run-1",
      role: "agent",
      image: "appstrate-pi:latest",
      env: { AGENT_PROMPT: "hi" },
      resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
    };
    const handle = await client.createWorkload(spec, boundary);
    expect(handle).toEqual(HANDLE);
    const workloadCall = fake.calls.find(([name]) => name === "createWorkload");
    expect(workloadCall?.[1][0]).toEqual(spec);

    await client.startWorkload(handle);

    const lines: string[] = [];
    for await (const line of client.streamLogs(handle)) lines.push(line);
    expect(lines).toEqual(["guest line 1", "guest line 2", "guest line 3"]);

    expect(await client.waitForExit(handle)).toBe(42);
    expect(await client.stopByRunId("run-1", 5)).toBe("stopped");
    const stopCall = fake.calls.find(([name]) => name === "stopByRunId");
    expect(stopCall?.[1]).toEqual(["run-1", 5]);

    await client.removeIsolationBoundary(boundary);
    const removeCall = fake.calls.find(([name]) => name === "removeIsolationBoundary");
    expect(removeCall?.[1][0]).toEqual(BOUNDARY);

    expect(await client.resolvePlatformApiUrl()).toBe("http://192.168.1.10:3000");
  });

  it("rejects inflated supplemental resources at the daemon ingress", async () => {
    const fake = makeFakeOrchestrator();
    const client = makeClient(fake);
    await client.initialize();

    await expect(
      client.createIsolationBoundary("run-1", {
        requirements: {
          capabilities: [{ kind: "browser", profile: "standard", instances: 1 }],
          supplementalResources: {
            memoryBytes: 64 * 1024 * 1024 * 1024,
            nanoCpus: 64_000_000_000,
            pidsLimit: 65_535,
          },
        },
      }),
    ).rejects.toThrow(/400|invalid/i);
    expect(fake.calls.find(([name]) => name === "createIsolationBoundary")).toBeUndefined();
  });

  it("client shutdown never reaches the daemon's orchestrator", async () => {
    const fake = makeFakeOrchestrator();
    const client = makeClient(fake);
    await client.initialize();
    await client.shutdown();
    expect(fake.calls.find(([name]) => name === "shutdown")).toBeUndefined();
  });

  it("a wrong platform-side token is rejected by the daemon", async () => {
    const fake = makeFakeOrchestrator();
    const app = createRunnerApp({ orchestrator: fake, token: "another-secret-token-9876543210" });
    const fetchFn = ((input: string | URL, init?: RequestInit) =>
      app.request(String(input), init)) as typeof fetch;
    const client = new RemoteFirecrackerOrchestrator({ fetchFn, retryBaseMs: 1 });
    await expect(client.initialize()).rejects.toThrow(/unauthorized|401/i);
    expect(fake.calls.length).toBe(0);
  });
});
