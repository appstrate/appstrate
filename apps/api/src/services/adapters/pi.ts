// SPDX-License-Identifier: Apache-2.0

/**
 * Pi-container execution function — produces a {@link RunEvent} stream
 * by orchestrating a Docker workload + sidecar for a single run.
 *
 * Exported as a function (not a class) so {@link AppstrateContainerRunner}
 * composes it via constructor injection. Tests inject a fake
 * {@link ContainerExecutor} to run without Docker.
 */

import { logger } from "../../lib/logger.ts";
import type { AppstrateRunPlan } from "./types.ts";
import { buildPlatformSystemPrompt } from "./prompt-builder.ts";
import { TimeoutError } from "./types.ts";
import { runContainerLifecycle, RunTimeoutError } from "@appstrate/afps-runtime/runner";
import { buildRuntimePiEnv, processPiLogs } from "@appstrate/runner-pi";
import { sanitizeStorageKey } from "../file-storage.ts";
import {
  getOrchestrator,
  type ContainerOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";

import { getEnv } from "@appstrate/env";

/**
 * The container-execution seam used by {@link AppstrateContainerRunner}.
 * A `ContainerExecutor` yields {@link RunEvent}s for the duration of a
 * single run and cleans up container resources on return / throw.
 */
export type ContainerExecutor = (
  runId: string,
  context: ExecutionContext,
  plan: AppstrateRunPlan,
  signal?: AbortSignal,
) => AsyncGenerator<RunEvent>;

/**
 * Default container executor — drives a Pi agent container + sidecar.
 *
 * Inject a custom {@link ContainerOrchestrator} for tests (mocks Docker).
 * In production, pass `undefined` and the global orchestrator is used.
 */
export function createPiContainerExecutor(orchestrator?: ContainerOrchestrator): ContainerExecutor {
  return async function* piContainerExecutor(
    runId,
    context,
    plan,
    signal,
  ): AsyncGenerator<RunEvent> {
    const prompt = buildPlatformSystemPrompt(context, plan);

    const { llmConfig } = plan;
    const modelId = llmConfig.modelId;

    const orch = orchestrator ?? getOrchestrator();
    let boundary: IsolationBoundary | undefined;
    let sidecarHandle: WorkloadHandle | undefined;

    try {
      // Phase 1: Create isolation boundary
      boundary = await orch.createIsolationBoundary(runId);

      // Resolve LLM config for sidecar proxy
      const llmApiKey = llmConfig.apiKey;
      const llmPlaceholder = deriveKeyPlaceholder(llmApiKey);

      // Sidecar config (platform network resolution handled by orchestrator)
      const sidecarConfig = {
        runToken: plan.runApi?.token ?? "",
        platformApiUrl: plan.runApi?.url ?? "",
        proxyUrl: plan.proxyUrl ?? undefined,
        llm: llmApiKey
          ? { baseUrl: llmConfig.baseUrl, apiKey: llmApiKey, placeholder: llmPlaceholder }
          : undefined,
      };

      // Build agent env — NO RUN_TOKEN, NO PLATFORM_API_URL, NO ExtraHosts.
      // Route LLM calls through sidecar proxy (agent never sees real API keys);
      // all outbound HTTP traffic routed through the sidecar forward proxy.
      const hasOutputSchema =
        plan.schemas.output?.properties && Object.keys(plan.schemas.output.properties).length > 0;
      const containerEnv = buildRuntimePiEnv({
        model: {
          api: llmConfig.api,
          modelId,
          baseUrl: llmConfig.baseUrl,
          apiKey: llmApiKey,
          apiKeyPlaceholder: llmPlaceholder,
          input: llmConfig.input,
          contextWindow: llmConfig.contextWindow,
          maxTokens: llmConfig.maxTokens,
          reasoning: llmConfig.reasoning,
          cost: llmConfig.cost,
        },
        agentPrompt: prompt,
        sidecarProxyLlmUrl: llmApiKey ? "http://sidecar:8080/llm" : undefined,
        connectedProviders: plan.providers.filter((s) => plan.tokens[s.id]).map((s) => s.id),
        outputSchema: hasOutputSchema ? plan.schemas.output : undefined,
        forwardProxyUrl: "http://sidecar:8081",
      });

      // Prepare files for batch injection into agent
      const filesToInject: Array<{ name: string; content: Buffer }> = [];
      if (plan.agentPackage) {
        filesToInject.push({ name: "agent-package.afps", content: plan.agentPackage });
      }
      if (plan.inputFiles) {
        for (const f of plan.inputFiles) {
          filesToInject.push({
            name: `documents/${sanitizeStorageKey(f.name)}`,
            content: f.buffer,
          });
        }
      }

      // Ensure runtime images are present (may have been pruned since boot)
      await orch.ensureImages([getEnv().PI_IMAGE, getEnv().SIDECAR_IMAGE]);

      // Phase 2: Setup sidecar + create agent (parallel)
      const [sidecar, agent] = await Promise.all([
        orch.createSidecar(runId, boundary, sidecarConfig),
        orch.createWorkload(
          {
            runId,
            role: "agent",
            image: getEnv().PI_IMAGE,
            env: containerEnv,
            resources: { memoryBytes: 1536 * 1024 * 1024, nanoCpus: 2_000_000_000 },
            files:
              filesToInject.length > 0
                ? { items: filesToInject, targetDir: "/workspace" }
                : undefined,
          },
          boundary,
        ),
      ]);
      sidecarHandle = sidecar;

      // Phase 3: Run agent container lifecycle (start + stream + wait + cleanup)
      try {
        yield* runContainerLifecycle<WorkloadHandle>({
          orchestrator: orch,
          handle: agent,
          adapterName: "pi",
          runId,
          timeout: plan.timeout,
          extraData: { api: llmConfig.api, model: modelId },
          signal,
          stopOnTimeout: [sidecarHandle],
          processLogs: (logs) => processPiLogs(logs, runId),
          onRemoveError: (h, err) => {
            logger.error("Failed to remove workload", {
              workloadId: h.id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        });
      } catch (err) {
        if (err instanceof RunTimeoutError) {
          throw new TimeoutError(err.message);
        }
        throw err;
      }
    } finally {
      // Cleanup sidecar first, then boundary (network requires all containers disconnected)
      if (sidecarHandle) {
        await orch.removeWorkload(sidecarHandle).catch((err) => {
          logger.error("Failed to remove sidecar", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (boundary) {
        await orch.removeIsolationBoundary(boundary).catch((err) => {
          logger.error("Failed to remove network", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  };
}

// --- Helpers ---

/**
 * Derive a placeholder that preserves the key's dash-separated prefix.
 * The last segment (the secret) is replaced; prefix segments are kept intact.
 * This ensures the SDK's prefix-based behavior (e.g. OAuth detection, auth header
 * format, beta headers) works identically with the placeholder.
 */
function deriveKeyPlaceholder(key: string | undefined): string {
  if (!key) return "sk-placeholder";
  const parts = key.split("-");
  if (parts.length <= 1) return "sk-placeholder";
  return parts.slice(0, -1).join("-") + "-placeholder";
}

/** @internal Exported for testing */
export { deriveKeyPlaceholder as _deriveKeyPlaceholderForTesting };
