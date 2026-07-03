// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate-runner` HTTP surface (runner/server.ts)
 * — pure wire-level coverage with a fake orchestrator: bearer auth,
 * body validation, error mapping, the exit long-poll, and NDJSON log
 * streaming. No network, no KVM, no Linux: the app is driven entirely
 * through `app.request()`.
 */

import { describe, it, expect } from "bun:test";
import type {
  CleanupReport,
  IsolationBoundary,
  StopResult,
  WorkloadHandle,
} from "@appstrate/core/platform-types";
import { createRunnerApp, type RunnerOrchestrator } from "../../runner/server.ts";
import {
  CONSOLE_MAX_TAIL_BYTES,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_ROUTES,
  workloadConsolePath,
} from "../../runner/protocol.ts";

const TOKEN = "unit-test-token-0123456789";

interface RecordedCall {
  method: string;
  args: unknown[];
}

const BOUNDARY: IsolationBoundary = {
  id: "b-1",
  name: "appstrate-run-1",
  workspace: { kind: "directory", path: "/workspace" },
  sidecarEndpoints: {
    sidecarUrl: "http://127.0.0.1:8080",
    llmProxyUrl: "http://127.0.0.1:8080/llm",
    forwardProxyUrl: "http://127.0.0.1:8081",
    noProxy: "127.0.0.1",
  },
};

const AGENT_HANDLE: WorkloadHandle = { id: "wl-1", runId: "run-1", role: "agent" };

const CLEANUP: CleanupReport = { workloads: 1, isolationBoundaries: 2, workspaces: 3 };

/**
 * Plain-object RunOrchestrator: every method records its arguments and
 * returns a canned value. Individual tests override the method under
 * test (throwing, never resolving, custom generator).
 */
function fakeOrchestrator(overrides: Partial<RunnerOrchestrator> = {}): {
  orchestrator: RunnerOrchestrator;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record =
    <T>(method: string, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(value);
    };
  const orchestrator: RunnerOrchestrator = {
    initialize: record("initialize", undefined),
    shutdown: record("shutdown", undefined),
    cleanupOrphans: record("cleanupOrphans", CLEANUP),
    ensureImages: record("ensureImages", undefined),
    createIsolationBoundary: record("createIsolationBoundary", BOUNDARY),
    removeIsolationBoundary: record("removeIsolationBoundary", undefined),
    createSidecar: record("createSidecar", { ...AGENT_HANDLE, role: "sidecar" }),
    createWorkload: record("createWorkload", AGENT_HANDLE),
    startWorkload: record("startWorkload", undefined),
    stopWorkload: record("stopWorkload", undefined),
    removeWorkload: record("removeWorkload", undefined),
    waitForExit: record("waitForExit", 0),
    streamLogs: async function* (): AsyncGenerator<string> {
      calls.push({ method: "streamLogs", args: [] });
      yield* [] as string[];
    },
    stopByRunId: record<StopResult>("stopByRunId", "stopped"),
    resolvePlatformApiUrl: record("resolvePlatformApiUrl", "http://10.0.0.1:3000"),
    workloadStatus: (handle) => {
      calls.push({ method: "workloadStatus", args: [handle] });
      return { running: true, uptimeMs: 1234 };
    },
    readConsole: (id, tailBytes) => {
      calls.push({ method: "readConsole", args: [id, tailBytes] });
      return Promise.resolve(null);
    },
    ...overrides,
  };
  return { orchestrator, calls };
}

function makeApp(overrides: Partial<RunnerOrchestrator> = {}, exitLongPollMs?: number) {
  const { orchestrator, calls } = fakeOrchestrator(overrides);
  const app = createRunnerApp({
    orchestrator,
    token: TOKEN,
    ...(exitLongPollMs !== undefined ? { exitLongPollMs } : {}),
  });
  return { app, calls };
}

function post(app: ReturnType<typeof makeApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("runner server auth", () => {
  it("rejects requests without a token", async () => {
    const { app } = makeApp();
    const res = await app.request(RUNNER_ROUTES.health);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with a wrong token (same length included)", async () => {
    const { app } = makeApp();
    for (const bad of ["nope", "x".repeat(TOKEN.length)]) {
      const res = await app.request(RUNNER_ROUTES.health, {
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it("accepts the shared token", async () => {
    const { app } = makeApp();
    const res = await app.request(RUNNER_ROUTES.health, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("runner server routes", () => {
  it("answers health with the protocol version", async () => {
    const { app } = makeApp();
    const res = await app.request(RUNNER_ROUTES.health, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toEqual({
      ok: true,
      adapter: "firecracker",
      protocol: RUNNER_PROTOCOL_VERSION,
      initialized: true,
    });
  });

  it("includes the boot-time guest-path probe snapshot on health when provided", async () => {
    const { orchestrator } = fakeOrchestrator();
    const app = createRunnerApp({
      orchestrator,
      token: TOKEN,
      health: { platformReachable: true, guestPathVerified: false },
    });
    const res = await app.request(RUNNER_ROUTES.health, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toEqual({
      ok: true,
      adapter: "firecracker",
      protocol: RUNNER_PROTOCOL_VERSION,
      initialized: true,
      platformReachable: true,
      guestPathVerified: false,
    });
  });

  it("carries a null guestPathVerified (degraded probe) through the payload", async () => {
    const { orchestrator } = fakeOrchestrator();
    const app = createRunnerApp({
      orchestrator,
      token: TOKEN,
      health: { platformReachable: true, guestPathVerified: null },
    });
    const res = await app.request(RUNNER_ROUTES.health, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.guestPathVerified).toBeNull();
    expect(body.platformReachable).toBe(true);
  });

  it("creates a boundary and forwards runId + opts", async () => {
    const { app, calls } = makeApp();
    const res = await post(app, RUNNER_ROUTES.createBoundary, {
      runId: "run-1",
      opts: { skipSidecar: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BOUNDARY as unknown as Record<string, unknown>);
    expect(calls).toEqual([
      { method: "createIsolationBoundary", args: ["run-1", { skipSidecar: true }] },
    ]);
  });

  it("returns 400 with a message summary on an invalid body", async () => {
    const { app, calls } = makeApp();
    const res = await post(app, RUNNER_ROUTES.createBoundary, { runId: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("runId");
    // The orchestrator must never see an unvalidated payload.
    expect(calls).toEqual([]);
  });

  it("maps an orchestrator error to 500 with the message only", async () => {
    const { app } = makeApp({
      createIsolationBoundary: () => Promise.reject(new Error("tap allocation failed")),
    });
    const res = await post(app, RUNNER_ROUTES.createBoundary, { runId: "run-1" });
    expect(res.status).toBe(500);
    // Exactly the message — no stack, no error class name.
    expect(await res.json()).toEqual({ error: "tap allocation failed" });
  });

  it("forwards the sidecar spec verbatim, extra fields included", async () => {
    const { app, calls } = makeApp();
    const spec = {
      runToken: "tok-1",
      llmProxy: { baseUrl: "https://api.anthropic.com" },
      futureField: { nested: [1, 2, 3] },
    };
    const res = await post(app, RUNNER_ROUTES.createSidecar, {
      runId: "run-1",
      boundary: BOUNDARY,
      spec,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "createSidecar", args: ["run-1", BOUNDARY, spec] }]);
  });

  it("long-polls exit: immediate exit answers { done: true, code }", async () => {
    const { app } = makeApp({ waitForExit: () => Promise.resolve(7) });
    const res = await post(app, RUNNER_ROUTES.waitForExit, { handle: AGENT_HANDLE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, code: 7 });
  });

  it("long-polls exit: a still-running workload answers { done: false }", async () => {
    // Never-resolving waitForExit + a 50ms injected window keeps the
    // test fast without touching the production 45s constant.
    const { app } = makeApp({ waitForExit: () => new Promise<number>(() => {}) }, 50);
    const res = await post(app, RUNNER_ROUTES.waitForExit, { handle: AGENT_HANDLE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: false });
  });

  it("streams logs as NDJSON and honors skip", async () => {
    const lines = ["l1", "l2", "l3", "l4", "l5"];
    const { app } = makeApp({
      streamLogs: async function* (): AsyncGenerator<string> {
        yield* lines;
      },
    });
    const res = await post(app, RUNNER_ROUTES.streamLogs, { handle: AGENT_HANDLE, skip: 3 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const received = (await res.text())
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { line: string }).line);
    expect(received).toEqual(["l4", "l5"]);
  });

  it("passes the stop-run result through and forwards the timeout", async () => {
    const { app, calls } = makeApp();
    const res = await post(app, RUNNER_ROUTES.stopRun, { runId: "run-1", timeoutSeconds: 9 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stopped" });
    expect(calls).toEqual([{ method: "stopByRunId", args: ["run-1", 9] }]);
  });

  it("reports workload liveness", async () => {
    const { app, calls } = makeApp();
    const res = await post(app, RUNNER_ROUTES.workloadStatus, { handle: AGENT_HANDLE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true, uptimeMs: 1234 });
    expect(calls).toEqual([{ method: "workloadStatus", args: [AGENT_HANDLE] }]);
  });
});

const authGet = (app: ReturnType<typeof makeApp>["app"], path: string) =>
  app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });

describe("runner server console route", () => {
  it("serves the console tail with the requested (clamped) byte budget", async () => {
    let seen: [string, number] | undefined;
    const { app } = makeApp({
      readConsole: (id, tailBytes) => {
        seen = [id, tailBytes];
        return Promise.resolve(`console for ${id}`);
      },
    });
    const res = await authGet(app, `${workloadConsolePath("run-1")}?tailBytes=999999999`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("console for run-1");
    // Over-cap request is clamped down to the max, never rejected.
    expect(seen).toEqual(["run-1", CONSOLE_MAX_TAIL_BYTES]);
  });

  it("defaults tailBytes when the query is absent", async () => {
    let seen: [string, number] | undefined;
    const { app } = makeApp({
      readConsole: (id, tailBytes) => {
        seen = [id, tailBytes];
        return Promise.resolve("live");
      },
    });
    const res = await authGet(app, workloadConsolePath("run-1"));
    expect(res.status).toBe(200);
    expect(seen?.[1]).toBe(64 * 1024);
  });

  it("404s when neither live nor archived console exists", async () => {
    const { app } = makeApp({ readConsole: () => Promise.resolve(null) });
    const res = await authGet(app, workloadConsolePath("run-1"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("run-1");
  });

  it("rejects a path-traversing id before touching the orchestrator", async () => {
    let called = false;
    const { app } = makeApp({
      readConsole: () => {
        called = true;
        return Promise.resolve("nope");
      },
    });
    // `..%2f..` decodes to a traversal attempt — the charset guard rejects it.
    const res = await authGet(app, "/v1/workloads/..%2f..%2fetc/console");
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("requires the bearer token like every other route", async () => {
    const { app } = makeApp({ readConsole: () => Promise.resolve("secret") });
    const res = await app.request(workloadConsolePath("run-1"));
    expect(res.status).toBe(401);
  });
});
