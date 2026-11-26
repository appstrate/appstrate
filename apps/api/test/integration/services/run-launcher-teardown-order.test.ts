// SPDX-License-Identifier: Apache-2.0

/**
 * The launcher's teardown gives the sidecar its stop grace before removing it.
 *
 * A remove is a SIGKILL; a stop is SIGTERM + grace, during which the sidecar
 * sends the call journal it still holds. The platform takes that journal only
 * while the run is `running`, and for a run that did not finalize itself the
 * terminal status is synthesised by `executeAgentInBackground` AFTER
 * `runPlatformContainer` returns — so the whole teardown must complete before
 * it does.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type {
  RunOrchestrator,
  IsolationBoundary,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import { defaultTestAgentResources } from "../../helpers/run-resources.ts";

function recordingFake(opts: { agentExitCode: number; sidecarStopFails?: boolean }): {
  orchestrator: RunOrchestrator;
  order: string[];
} {
  const order: string[] = [];
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
    async removeIsolationBoundary() {
      order.push("remove:boundary");
    },
    async createSidecar(runId: string): Promise<WorkloadHandle> {
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      return { id: `agent_${spec.runId}`, runId: spec.runId, role: spec.role };
    },
    async startWorkload() {},
    async stopWorkload(handle: WorkloadHandle) {
      order.push(`stop:${handle.role}`);
      // A stop resolves only once the workload has exited after its grace.
      await new Promise((r) => setTimeout(r, 20));
      if (handle.role === "sidecar" && opts.sidecarStopFails) {
        throw new Error("daemon unreachable");
      }
      order.push(`stopped:${handle.role}`);
    },
    async removeWorkload(handle: WorkloadHandle) {
      order.push(`remove:${handle.role}`);
    },
    async waitForExit(): Promise<number> {
      return opts.agentExitCode;
    },
    async *streamLogs(): AsyncGenerator<string> {},
    async stopByRunId(): Promise<StopResult> {
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };
  return { orchestrator, order };
}

function buildRunPlan(): AppstrateRunPlan {
  const manifest = { name: "@test/agent", version: "1.0.0", type: "agent" };
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  files.set("prompt.md", new TextEncoder().encode("Do the thing."));
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
      dialect: null,
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.test",
      modelId: "claude-3-5-sonnet-latest",
      apiKey: "sk-test-secret",
      label: "Test Model",
      credentialSource: "org",
      aliased: false,
      aliasId: "claude-3-5-sonnet-latest",
    },
    timeout: 60,
    resources: defaultTestAgentResources(),
  };
}

async function launch(orchestrator: RunOrchestrator, order: string[]): Promise<void> {
  const runId = "run_teardown_order";
  await runPlatformContainer({
    runId,
    context: { runId, input: {}, memories: [] },
    plan: buildRunPlan(),
    sinkCredentials: mintSinkCredentials({
      runId,
      appUrl: "http://platform:3000",
      ttlSeconds: 60,
    }),
    orchestrator,
  }).catch(() => {});
  order.push("returned");
}

describe("run-launcher — teardown order", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  for (const [label, agentExitCode] of [
    ["an agent that exited 0", 0],
    ["an agent that crashed", 1],
  ] as const) {
    it(`stops the sidecar, then removes it, before returning, for ${label}`, async () => {
      const { orchestrator, order } = recordingFake({ agentExitCode });
      await launch(orchestrator, order);
      expect(order).toEqual([
        "stop:sidecar",
        "stopped:sidecar",
        "remove:sidecar",
        "remove:agent",
        "remove:boundary",
        "returned",
      ]);
    });
  }

  it("still removes the sidecar when its stop fails", async () => {
    const { orchestrator, order } = recordingFake({ agentExitCode: 0, sidecarStopFails: true });
    await launch(orchestrator, order);
    expect(order).toEqual([
      "stop:sidecar",
      "remove:sidecar",
      "remove:agent",
      "remove:boundary",
      "returned",
    ]);
  });
});
