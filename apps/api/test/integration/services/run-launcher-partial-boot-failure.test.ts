// SPDX-License-Identifier: Apache-2.0

/**
 * `runPlatformContainer` teardown when the parallel boot PARTIALLY fails.
 *
 * The three-way race in `run-launcher/pi.ts` (createSidecar + createWorkload +
 * uploadBundle) used `Promise.all`, which assigns `sidecarHandle` /
 * `agentHandle` only after the `await` returns. One rejecting branch therefore
 * left every SUCCEEDING branch's workload unassigned, so the `finally`'s
 * `if (sidecarHandle)` / `if (agentHandle)` guards removed nothing — and on
 * Docker the still-attached agent container makes `removeIsolationBoundary`'s
 * network + volume removals 409 as well. Container, network and volume all
 * leaked, holding the run's env: RUN_TOKEN, sink secret, model credentials,
 * sidecar auth token. Nothing reclaims them (`cleanupOrphans()` runs at boot).
 *
 * Each branch is covered separately because they fail in different orders and
 * strand different handles. The slow-branch case is the second half of the same
 * defect: `Promise.all` resumed the caller while `createWorkload` was still in
 * flight, so the container was born AFTER cleanup had already run.
 *
 * No real Docker — the fake orchestrator records what it was ASKED to remove.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type {
  RunOrchestrator,
  IsolationBoundary,
  SidecarLaunchSpec,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { defaultTestAgentResources } from "../../helpers/run-resources.ts";

// ---------------------------------------------------------------------------
// Fake orchestrator with teardown observability
// ---------------------------------------------------------------------------

/** Which of the three parallel branches rejects (`none` = the happy path). */
type FailingBranch = "none" | "sidecar" | "workload" | "upload";

interface TeardownObservations {
  /** Handle ids passed to `removeWorkload`, in call order. */
  removedWorkloads: string[];
  /** Boundary ids passed to `removeIsolationBoundary`. */
  removedBoundaries: string[];
  /** Ids `createWorkload` / `createSidecar` actually handed out. */
  createdWorkloads: string[];
}

const SIDECAR_FAILURE = new Error("fake: sidecar create failed");
const WORKLOAD_FAILURE = new Error("fake: workload create failed");
const UPLOAD_FAILURE = new Error("fake: bundle upload failed");

function createTeardownFake(failing: FailingBranch): {
  orchestrator: RunOrchestrator;
  obs: TeardownObservations;
} {
  const obs: TeardownObservations = {
    removedWorkloads: [],
    removedBoundaries: [],
    createdWorkloads: [],
  };

  const orchestrator: RunOrchestrator = {
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
    async removeIsolationBoundary(boundary: IsolationBoundary) {
      obs.removedBoundaries.push(boundary.id);
    },
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      _spec: SidecarLaunchSpec,
    ): Promise<WorkloadHandle> {
      if (failing === "sidecar") throw SIDECAR_FAILURE;
      const id = `sidecar_${runId}`;
      obs.createdWorkloads.push(id);
      return { id, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      // Deliberately the SLOWEST branch: when the sidecar rejects, the agent
      // container is created after that rejection. `Promise.all` had already
      // resumed the caller by then and torn down; only `allSettled` waits for
      // this handle to exist so the `finally` can reclaim it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (failing === "workload") throw WORKLOAD_FAILURE;
      const id = `agent_${spec.runId}`;
      obs.createdWorkloads.push(id);
      return { id, runId: spec.runId, role: spec.role };
    },
    async startWorkload() {},
    async stopWorkload() {},
    async removeWorkload(handle: WorkloadHandle) {
      obs.removedWorkloads.push(handle.id);
    },
    async waitForExit(): Promise<number> {
      return 0;
    },
    async *streamLogs(): AsyncGenerator<string> {},
    async stopByRunId(): Promise<StopResult> {
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };

  return { orchestrator, obs };
}

// ---------------------------------------------------------------------------
// Fixtures (mirror run-launcher-parallel-boot.test.ts)
// ---------------------------------------------------------------------------

function buildTestBundle(): AppstrateRunPlan["bundle"] {
  const manifest = { name: "@test/agent", version: "1.0.0", type: "agent" };
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  files.set("prompt.md", new TextEncoder().encode("Do the thing."));
  const identity = "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"];
  const packages: AppstrateRunPlan["bundle"]["packages"] = new Map();
  packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  return { bundleFormatVersion: "1.0", root: identity, packages, integrity: "sha256-stub" };
}

function buildRunPlan(): AppstrateRunPlan {
  return {
    bundle: buildTestBundle(),
    rawPrompt: "Do the thing.",
    runToken: "test-run-token",
    llmConfig: {
      providerId: "anthropic",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-3-5-sonnet-latest",
      apiKey: "sk-test-secret",
      label: "Test Model",
      isSystemModel: false,
      aliased: false,
      aliasId: "claude-3-5-sonnet-latest",
    },
    // At least one integration, otherwise the launcher's skipSidecar shortcut
    // bypasses `createSidecar` and there is no three-way race to test.
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
    timeout: 60,
    resources: defaultTestAgentResources(),
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [] };
}

/** Drive one launch, returning whatever it threw (or `null` on success). */
async function launch(
  runId: string,
  failing: FailingBranch,
): Promise<{ obs: TeardownObservations; error: unknown }> {
  const { orchestrator, obs } = createTeardownFake(failing);
  const error = await runPlatformContainer({
    runId,
    context: buildContext(runId),
    plan: buildRunPlan(),
    sinkCredentials: mintSinkCredentials({
      runId,
      appUrl: "http://platform:3000",
      ttlSeconds: 60,
    }),
    orchestrator,
    uploadBundle: async () => {
      if (failing === "upload") throw UPLOAD_FAILURE;
    },
  }).then(
    () => null,
    (err: unknown) => err,
  );
  return { obs, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPlatformContainer — partial parallel-boot failure", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // CONTROL. Passes before and after the fix: it proves the fake actually
  // records removals, so a green "was asked to remove" assertion below cannot
  // be an artifact of a fake that records nothing.
  it("removes both workloads and the boundary on the happy path", async () => {
    const { obs, error } = await launch("run_ok", "none");

    expect(error).toBeNull();
    expect(obs.createdWorkloads).toEqual(["sidecar_run_ok", "agent_run_ok"]);
    expect(obs.removedWorkloads).toEqual(["sidecar_run_ok", "agent_run_ok"]);
    expect(obs.removedBoundaries).toEqual(["net_run_ok"]);
  });

  it("removes the agent workload when createSidecar rejects", async () => {
    const { obs, error } = await launch("run_sidecar_fail", "sidecar");

    // The original failure still reaches the caller, unwrapped.
    expect(error).toBe(SIDECAR_FAILURE);
    // The agent container was created — 100ms AFTER the sidecar rejected.
    expect(obs.createdWorkloads).toEqual(["agent_run_sidecar_fail"]);
    // …and it must be handed back, credentials and all.
    expect(obs.removedWorkloads).toEqual(["agent_run_sidecar_fail"]);
    expect(obs.removedBoundaries).toEqual(["net_run_sidecar_fail"]);
  });

  it("removes the sidecar workload when createWorkload rejects", async () => {
    const { obs, error } = await launch("run_workload_fail", "workload");

    expect(error).toBe(WORKLOAD_FAILURE);
    expect(obs.createdWorkloads).toEqual(["sidecar_run_workload_fail"]);
    expect(obs.removedWorkloads).toEqual(["sidecar_run_workload_fail"]);
    expect(obs.removedBoundaries).toEqual(["net_run_workload_fail"]);
  });

  it("removes both workloads when the bundle upload rejects", async () => {
    const { obs, error } = await launch("run_upload_fail", "upload");

    expect(error).toBe(UPLOAD_FAILURE);
    // Neither create failed here, so BOTH handles exist and both must go.
    expect(obs.createdWorkloads).toEqual(["sidecar_run_upload_fail", "agent_run_upload_fail"]);
    expect(obs.removedWorkloads).toEqual(["sidecar_run_upload_fail", "agent_run_upload_fail"]);
    expect(obs.removedBoundaries).toEqual(["net_run_upload_fail"]);
  });
});
