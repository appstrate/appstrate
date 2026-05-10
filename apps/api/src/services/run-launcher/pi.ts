// SPDX-License-Identifier: Apache-2.0

/**
 * Pi-container platform runner — spawns the sidecar + agent workloads for a
 * single run, waits for the agent container to exit, and reports the terminal
 * lifecycle state back to the caller.
 *
 * No event iteration. No stdout parsing. The agent container uses
 * {@link HttpSink} (wired via `APPSTRATE_SINK_URL` + `APPSTRATE_SINK_SECRET`)
 * to POST every {@link RunEvent} + its terminal {@link RunResult} directly
 * to the platform's signed-event API. The platform's event-ingestion
 * pipeline is the single persistence path for every run — platform or
 * remote — and the server-side `executeAgentInBackground` is reduced to
 * container lifecycle management.
 *
 * On graceful completion the container itself calls `sink.finalize(result)`
 * and the server's `finalizeRun()` closes the sink idempotently. If
 * the container crashes or times out without calling finalize, the caller
 * synthesises a terminal result from {@link PlatformContainerResult} and
 * re-enters `finalizeRun()` — the CAS on `sink_closed_at IS NULL`
 * guarantees exactly-once closure even when container-side and
 * server-side finalize race.
 */

import { logger } from "../../lib/logger.ts";
import type { AppstrateRunPlan } from "./types.ts";
import { buildPlatformSystemPrompt } from "./prompt-builder.ts";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import { sanitizeStorageKey } from "../file-storage.ts";
import {
  getOrchestrator,
  type ContainerOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { SinkCredentials } from "../../lib/mint-sink-credentials.ts";

import { getEnv } from "@appstrate/env";

/** Terminal state reported back to the caller once the container has exited. */
export interface PlatformContainerResult {
  /** Exit code reported by the orchestrator (0 = clean, non-zero = crash). */
  exitCode: number;
  /** Whether the agent container was stopped because the run timed out. */
  timedOut: boolean;
  /** Whether the run was cancelled by the caller's `AbortSignal`. */
  cancelled: boolean;
}

export interface RunPlatformContainerInput {
  runId: string;
  context: ExecutionContext;
  plan: AppstrateRunPlan;
  /** Sink credentials minted by the caller (`createRun`). Required. */
  sinkCredentials: SinkCredentials;
  /** Cancellation token — aborted = the run was cancelled by user. */
  signal?: AbortSignal;
  /** Injectable orchestrator — production defaults to the global singleton. */
  orchestrator?: ContainerOrchestrator;
}

/**
 * Start the Pi agent + sidecar for a platform-origin run, wait until the
 * agent container exits, and report the lifecycle outcome. The returned
 * {@link PlatformContainerResult} is consumed by the caller to synthesise
 * a terminal {@link finalizeRun} call when the container didn't
 * finalise itself.
 *
 * Never throws on container-side failures — the lifecycle outcome is
 * encoded in the returned shape. Only unexpected orchestrator errors
 * (e.g. Docker unreachable) propagate as exceptions.
 */
export async function runPlatformContainer(
  input: RunPlatformContainerInput,
): Promise<PlatformContainerResult> {
  const { runId, context, plan, sinkCredentials, signal } = input;
  const orch = input.orchestrator ?? getOrchestrator();

  const prompt = buildPlatformSystemPrompt(context, plan);
  const { llmConfig } = plan;
  const modelId = llmConfig.modelId;

  let boundary: IsolationBoundary | undefined;
  let sidecarHandle: WorkloadHandle | undefined;
  let agentHandle: WorkloadHandle | undefined;

  try {
    boundary = await orch.createIsolationBoundary(runId);

    const llmApiKey = llmConfig.apiKey;
    const llmPlaceholder = deriveKeyPlaceholder(llmApiKey);

    const sidecarConfig = {
      runToken: plan.runApi?.token ?? "",
      platformApiUrl: plan.runApi?.url ?? "",
      proxyUrl: plan.proxyUrl ?? undefined,
      llm: llmApiKey
        ? { baseUrl: llmConfig.baseUrl, apiKey: llmApiKey, placeholder: llmPlaceholder }
        : undefined,
    };

    const hasOutputSchema =
      plan.outputSchema?.properties && Object.keys(plan.outputSchema.properties).length > 0;
    const containerEnv = buildRuntimePiEnv({
      model: {
        api: llmConfig.apiShape,
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
      runId,
      sidecarProxyLlmUrl: llmApiKey ? "http://sidecar:8080/llm" : undefined,
      connectedProviders: plan.providers.filter((s) => plan.tokens[s.id]).map((s) => s.id),
      outputSchema: hasOutputSchema ? plan.outputSchema : undefined,
      forwardProxyUrl: "http://sidecar:8081",
      sink: {
        url: sinkCredentials.url,
        finalizeUrl: sinkCredentials.finalizeUrl,
        secret: sinkCredentials.secret,
      },
      // Forward the W3C trace from the spawning request — when set, the
      // container's outbound HTTP traffic (events, finalize, sidecar
      // proxy) becomes child spans of that trace. The runtime validates
      // the wire format and falls back to a fresh trace on malformed
      // values, so no defensive parsing is needed here.
      traceparent: context.traceparent,
    });

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

    await orch.ensureImages([getEnv().PI_IMAGE, getEnv().SIDECAR_IMAGE]);

    // Sidecar + agent setup in parallel (identical to the legacy path —
    // the only behavioural change is WHERE the agent's events end up).
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
    agentHandle = agent;

    return await waitForWorkload(orch, agent, sidecar, plan.timeout, signal);
  } finally {
    // Cleanup order: sidecar → agent → network boundary.
    // Removing the network boundary before its members are gone is an
    // error on Docker's side, so the finally chain must be strict.
    if (sidecarHandle) {
      await orch.removeWorkload(sidecarHandle).catch((err) => {
        logger.error("Failed to remove sidecar", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
    if (agentHandle) {
      await orch.removeWorkload(agentHandle).catch((err) => {
        logger.error("Failed to remove agent workload", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
    if (boundary) {
      await orch.removeIsolationBoundary(boundary).catch((err) => {
        logger.error("Failed to remove isolation boundary", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
  }
}

/**
 * Drive the agent container lifecycle: start, enforce timeout, propagate
 * cancellation, wait for exit. Sidecar is stopped alongside the agent on
 * any terminal condition so neither lingers after the run has ended.
 */
async function waitForWorkload(
  orch: ContainerOrchestrator,
  agent: WorkloadHandle,
  sidecar: WorkloadHandle,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
): Promise<PlatformContainerResult> {
  await orch.startWorkload(agent);

  // Ring-buffer the agent's stdout+stderr so a non-zero exit can be
  // diagnosed. The sink protocol normally carries structured events, but
  // early-boot failures (missing module, malformed env) happen before the
  // sink is wired — those only land on the container's log stream.
  const logBuffer: string[] = [];
  const MAX_LOG_LINES = 200;
  const logAbort = new AbortController();
  const logStream = (async () => {
    try {
      for await (const line of orch.streamLogs(agent, logAbort.signal)) {
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
      }
    } catch {
      // Log streaming is best-effort — swallow errors.
    }
  })();

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    orch.stopWorkload(agent).catch(() => {});
    orch.stopWorkload(sidecar).catch(() => {});
  }, timeoutSeconds * 1000);

  const onAbort = () => {
    orch.stopWorkload(agent).catch(() => {});
    orch.stopWorkload(sidecar).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const exitCode = await orch.waitForExit(agent);
    if (exitCode !== 0 && !timedOut && !signal?.aborted) {
      logAbort.abort();
      await logStream;
      logger.error("Agent container exited non-zero", {
        exitCode,
        logs: logBuffer.slice(-50).join("\n"),
      });
    }
    return {
      exitCode,
      timedOut,
      cancelled: signal?.aborted ?? false,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);
    logAbort.abort();
  }
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
