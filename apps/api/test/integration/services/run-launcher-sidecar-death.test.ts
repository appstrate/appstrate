// SPDX-License-Identifier: Apache-2.0

/**
 * A sidecar that dies while its run is live fails the run at once (#1561).
 *
 * Before, the launcher waited on the agent alone: the agent retried its MCP
 * handshake against a dead sidecar until its own deadline, and the run ended
 * on the agent's exit code, naming the wrong process. These tests drive
 * `runPlatformContainer` with a fake orchestrator whose exits are controlled
 * by hand, so each ordering (sidecar first, agent first, timeout, cancel) is
 * deterministic.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import type {
  RunOrchestrator,
  IsolationBoundary,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { logger } from "../../../src/lib/logger.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import { defaultTestAgentResources } from "../../helpers/run-resources.ts";

interface Exit {
  promise: Promise<number>;
  resolve: (code: number) => void;
  reject: (err: Error) => void;
}

function exit(): Exit {
  let resolve!: (code: number) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Exits are resolved by the test, or by `stopWorkload`: the sidecar stops at
 * once, the agent 20 ms later — so on a platform-requested stop the sidecar's
 * exit is always observed FIRST, the ordering that must not be misread as a
 * sidecar death.
 */
function createFake(opts: {
  sidecarExitsIndependently?: boolean;
  sidecarLogs?: string[];
  /** The sidecar's log stream yields `sidecarLogs`, then never ends, as on a wedged daemon. */
  sidecarLogsHang?: boolean;
}) {
  const agent = exit();
  const sidecar = exit();
  // An exit the in-flight wait has not observed yet, as between Docker polls.
  let unobservedSidecarExit: number | undefined;
  const stopped: string[] = [];
  const orchestrator: RunOrchestrator = {
    ...(opts.sidecarExitsIndependently !== undefined
      ? { sidecarExitsIndependently: opts.sidecarExitsIndependently }
      : {}),
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      return {
        id: `net_${runId}`,
        name: `appstrate-exec-${runId}`,
        workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
        sidecarEndpoints: {
          sidecarUrl: "http://fake-sidecar.test:19080",
          llmProxyUrl: "http://fake-sidecar.test:19080/llm",
          forwardProxyUrl: "http://fake-sidecar.test:19081",
          noProxy: "fake-sidecar.test,localhost,127.0.0.1",
        },
      };
    },
    async removeIsolationBoundary() {},
    async createSidecar(runId: string): Promise<WorkloadHandle> {
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      return { id: `agent_${spec.runId}`, runId: spec.runId, role: spec.role };
    },
    async startWorkload() {},
    async stopWorkload(handle: WorkloadHandle) {
      stopped.push(handle.role);
      if (handle.role === "sidecar") sidecar.resolve(137);
      else setTimeout(() => agent.resolve(137), 20);
    },
    async removeWorkload(handle: WorkloadHandle) {
      // A removed Docker container makes its pending wait reject (404).
      if (handle.role === "sidecar") sidecar.reject(new Error("container disappeared"));
    },
    waitForExit(handle: WorkloadHandle): Promise<number> {
      if (handle.role !== "sidecar") return agent.promise;
      // A fresh wait inspects at once, like Docker's first poll.
      return unobservedSidecarExit !== undefined
        ? Promise.resolve(unobservedSidecarExit)
        : sidecar.promise;
    },
    async *streamLogs(handle: WorkloadHandle): AsyncGenerator<string> {
      if (handle.role !== "sidecar") return;
      yield* opts.sidecarLogs ?? [];
      if (opts.sidecarLogsHang) await new Promise<never>(() => {});
    },
    async stopByRunId(): Promise<StopResult> {
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };
  const exitSidecarUnobserved = (code: number) => {
    unobservedSidecarExit = code;
  };
  return { orchestrator, agent, sidecar, stopped, exitSidecarUnobserved };
}

function buildRunPlan(timeout = 60): AppstrateRunPlan {
  const manifest = { name: "@test/agent", version: "1.0.0", type: "agent" };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
    ["prompt.md", new TextEncoder().encode("Do the thing.")],
  ]);
  const identity = "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"];
  const packages: AppstrateRunPlan["bundle"]["packages"] = new Map();
  packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  return {
    bundle: { bundleFormatVersion: "1.0", root: identity, packages, integrity: "sha256-stub" },
    rawPrompt: "Do the thing.",
    runToken: "test-run-token",
    llmConfig: {
      providerId: "anthropic",
      piProvider: "anthropic",
      apiShape: "anthropic-messages",
      // Allowlisted in the test preload: the launch-time egress check resolves no DNS.
      baseUrl: "https://api.anthropic.test",
      modelId: "claude-3-5-sonnet-latest",
      apiKey: "sk-test-secret",
      label: "Test Model",
      isSystemModel: false,
      aliased: false,
      aliasId: "claude-3-5-sonnet-latest",
    },
    // One integration so the launcher does not skip the sidecar.
    integrations: [
      {
        integrationId: "@test/gmail-mcp",
        namespace: "gmail",
        sourceKind: "local",
        manifest: { name: "@test/gmail-mcp", version: "1.0.0" },
        spawnEnv: {},
        toolAllowlist: [],
      },
    ],
    timeout,
    resources: defaultTestAgentResources(),
  };
}

function launch(
  runId: string,
  orchestrator: RunOrchestrator,
  extra: { timeout?: number; signal?: AbortSignal; timeoutBootGraceMs?: number } = {},
) {
  return runPlatformContainer({
    runId,
    context: { runId, input: {}, memories: [] },
    plan: buildRunPlan(extra.timeout),
    sinkCredentials: mintSinkCredentials({
      runId,
      appUrl: "http://platform:3000",
      ttlSeconds: 60,
    }),
    orchestrator,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.timeoutBootGraceMs !== undefined
      ? { timeoutBootGraceMs: extra.timeoutBootGraceMs }
      : {}),
  });
}

/** Let the launcher reach its wait before the test moves an exit. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const SIDECAR_CRASH_LOG = "Sidecar exited while the run was in progress";

describe("run launcher — sidecar death", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("fails the run at once and stops the agent when the sidecar exits first", async () => {
    const fake = createFake({ sidecarExitsIndependently: true });
    const run = launch("run_sidecar_dies", fake.orchestrator);
    await settle();
    fake.sidecar.resolve(1);
    await expect(run).rejects.toThrow("Sidecar exited with code 1 while the run was in progress");
    expect(fake.stopped).toContain("agent");
  });

  it("logs the sidecar's exit code and the tail of its logs", async () => {
    const logs = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const fake = createFake({ sidecarExitsIndependently: true, sidecarLogs: logs });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const run = launch("run_sidecar_tail", fake.orchestrator);
      await settle();
      fake.sidecar.resolve(1);
      await expect(run).rejects.toThrow("Sidecar exited with code 1");
      const call = errorSpy.mock.calls.find(([msg]) => msg === SIDECAR_CRASH_LOG);
      expect(call?.[1]).toEqual({
        runId: "run_sidecar_tail",
        exitCode: 1,
        tail: logs.slice(-30).join("\n"),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("still fails the run when the sidecar's log stream hangs", async () => {
    const fake = createFake({
      sidecarExitsIndependently: true,
      sidecarLogs: ["partial"],
      sidecarLogsHang: true,
    });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const run = launch("run_sidecar_logs_hang", fake.orchestrator);
      await settle();
      fake.sidecar.resolve(1);
      await expect(run).rejects.toThrow("Sidecar exited with code 1");
      const call = errorSpy.mock.calls.find(([msg]) => msg === SIDECAR_CRASH_LOG);
      // The time bound won: what was read is reported, flagged as not the log's end.
      expect(call?.[1]).toEqual({
        runId: "run_sidecar_logs_hang",
        exitCode: 1,
        tail: "partial",
        truncated: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
  }, 8_000);

  it("reports the sidecar's crash when the agent's exit wins the race", async () => {
    const fake = createFake({ sidecarExitsIndependently: true, sidecarLogs: ["boom"] });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const run = launch("run_both_exit", fake.orchestrator);
      await settle();
      fake.exitSidecarUnobserved(1);
      fake.agent.resolve(1);
      expect(await run).toEqual({ exitCode: 1, timedOut: false, stopRequested: false });
      const call = errorSpy.mock.calls.find(([msg]) => msg === SIDECAR_CRASH_LOG);
      expect(call?.[1]).toEqual({ runId: "run_both_exit", exitCode: 1, tail: "boom" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reports no sidecar crash when the agent fails alone", async () => {
    const fake = createFake({ sidecarExitsIndependently: true, sidecarLogs: ["fine"] });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const run = launch("run_agent_fails_alone", fake.orchestrator);
      await settle();
      const start = performance.now();
      fake.agent.resolve(1);
      expect(await run).toEqual({ exitCode: 1, timedOut: false, stopRequested: false });
      // A healthy sidecar must not hold up a failed run's teardown.
      expect(performance.now() - start).toBeLessThan(1_000);
      const messages = errorSpy.mock.calls.map(([msg]) => msg);
      expect(messages).toContain("Agent container exited non-zero");
      expect(messages).not.toContain(SIDECAR_CRASH_LOG);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("ignores the sidecar on an orchestrator that cannot observe it on its own", async () => {
    const fake = createFake({});
    const run = launch("run_shared_lifecycle", fake.orchestrator);
    await settle();
    fake.sidecar.resolve(1);
    await settle();
    fake.agent.resolve(0);
    expect(await run).toEqual({ exitCode: 0, timedOut: false, stopRequested: false });
    expect(fake.stopped).not.toContain("agent");
  });

  it("does not blame the sidecar when the agent exits first and teardown removes it", async () => {
    const fake = createFake({ sidecarExitsIndependently: true });
    const run = launch("run_agent_first", fake.orchestrator);
    await settle();
    fake.agent.resolve(0);
    expect(await run).toEqual({ exitCode: 0, timedOut: false, stopRequested: false });
  });

  it("falls back to waiting for the agent when the sidecar's exit cannot be observed", async () => {
    const fake = createFake({ sidecarExitsIndependently: true });
    const run = launch("run_sidecar_unobservable", fake.orchestrator);
    await settle();
    fake.sidecar.reject(new Error("daemon unreachable"));
    await settle();
    fake.agent.resolve(0);
    expect(await run).toEqual({ exitCode: 0, timedOut: false, stopRequested: false });
  });

  it("reports a timeout, not a sidecar death, when the timeout stops the sidecar first", async () => {
    const fake = createFake({ sidecarExitsIndependently: true });
    const result = await launch("run_timeout", fake.orchestrator, {
      timeout: 0,
      timeoutBootGraceMs: 50,
    });
    expect(result).toEqual({ exitCode: 137, timedOut: true, stopRequested: false });
  });

  it("reports a cancel, not a sidecar death, when the cancel stops the sidecar first", async () => {
    const fake = createFake({ sidecarExitsIndependently: true });
    const controller = new AbortController();
    const run = launch("run_cancel", fake.orchestrator, { signal: controller.signal });
    await settle();
    controller.abort();
    expect(await run).toEqual({ exitCode: 137, timedOut: false, stopRequested: true });
  });
});
