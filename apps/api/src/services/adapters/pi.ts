// SPDX-License-Identifier: Apache-2.0

import { logger } from "../../lib/logger.ts";
import type { RunAdapter, AppstrateRunPlan } from "./types.ts";
import { buildEnrichedPrompt } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import { sanitizeStorageKey } from "../file-storage.ts";
import {
  getOrchestrator,
  type ContainerOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";

import { getEnv } from "@appstrate/env";

export class PiAdapter implements RunAdapter {
  private readonly _orchestrator?: ContainerOrchestrator;

  constructor(orchestrator?: ContainerOrchestrator) {
    this._orchestrator = orchestrator;
  }

  async *execute(
    runId: string,
    context: ExecutionContext,
    plan: AppstrateRunPlan,
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    const prompt = buildEnrichedPrompt(context, plan);

    const { llmConfig } = plan;
    const modelId = llmConfig.modelId;

    const orchestrator = this._orchestrator ?? getOrchestrator();
    let boundary: IsolationBoundary | undefined;
    let sidecarHandle: WorkloadHandle | undefined;

    try {
      // Phase 1: Create isolation boundary
      boundary = await orchestrator.createIsolationBoundary(runId);

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

      // Build agent env — NO RUN_TOKEN, NO PLATFORM_API_URL, NO ExtraHosts
      const containerEnv: Record<string, string> = {
        AGENT_PROMPT: prompt,
        MODEL_API: llmConfig.api,
        MODEL_ID: modelId,
        SIDECAR_URL: "http://sidecar:8080",
      };

      const connectedProviderIds = plan.providers.filter((s) => plan.tokens[s.id]).map((s) => s.id);
      if (connectedProviderIds.length > 0) {
        containerEnv.CONNECTED_PROVIDERS = connectedProviderIds.join(",");
      }

      // Route LLM calls through sidecar proxy (agent never sees real API keys)
      if (llmApiKey) {
        containerEnv.MODEL_BASE_URL = "http://sidecar:8080/llm";
        containerEnv.MODEL_API_KEY = llmPlaceholder;
      }

      // Model capabilities (conditional — only set if defined)
      if (llmConfig.input) containerEnv.MODEL_INPUT = JSON.stringify(llmConfig.input);
      if (llmConfig.contextWindow != null)
        containerEnv.MODEL_CONTEXT_WINDOW = String(llmConfig.contextWindow);
      if (llmConfig.maxTokens != null) containerEnv.MODEL_MAX_TOKENS = String(llmConfig.maxTokens);
      if (llmConfig.reasoning != null)
        containerEnv.MODEL_REASONING = llmConfig.reasoning ? "true" : "false";
      if (llmConfig.cost) {
        containerEnv.MODEL_COST = JSON.stringify(llmConfig.cost);
      }

      // Output schema injection (optional — enables constrained decoding when present)
      const hasOutputSchema =
        plan.schemas.output?.properties && Object.keys(plan.schemas.output.properties).length > 0;

      if (hasOutputSchema) {
        containerEnv.OUTPUT_SCHEMA = JSON.stringify(plan.schemas.output);
      }

      // All outbound HTTP traffic routed through sidecar forward proxy.
      // The run network is internal (no NAT) — clients that ignore
      // HTTP_PROXY simply get connection failures, which is the desired behavior.
      containerEnv.HTTP_PROXY = "http://sidecar:8081";
      containerEnv.HTTPS_PROXY = "http://sidecar:8081";
      containerEnv.http_proxy = "http://sidecar:8081";
      containerEnv.https_proxy = "http://sidecar:8081";
      containerEnv.NO_PROXY = "sidecar,localhost,127.0.0.1";
      containerEnv.no_proxy = "sidecar,localhost,127.0.0.1";

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
      await orchestrator.ensureImages([getEnv().PI_IMAGE, getEnv().SIDECAR_IMAGE]);

      // Phase 2: Setup sidecar + create agent (parallel)
      const [sidecar, agent] = await Promise.all([
        orchestrator.createSidecar(runId, boundary, sidecarConfig),
        orchestrator.createWorkload(
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
      yield* runContainerLifecycle({
        orchestrator,
        handle: agent,
        adapterName: "pi",
        runId,
        timeout: plan.timeout,
        extraData: { api: llmConfig.api, model: modelId },
        signal,
        stopOnTimeout: [sidecarHandle],
        processLogs: (logs) => processPiLogs(logs, runId),
      });
    } finally {
      // Cleanup sidecar first, then boundary (network requires all containers disconnected)
      if (sidecarHandle) {
        await orchestrator.removeWorkload(sidecarHandle).catch((err) => {
          logger.error("Failed to remove sidecar", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (boundary) {
        await orchestrator.removeIsolationBoundary(boundary).catch((err) => {
          logger.error("Failed to remove network", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
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

async function* processPiLogs(
  logs: AsyncGenerator<string>,
  runId: string,
): AsyncGenerator<RunEvent> {
  let textBuffer = "";
  let inCodeBlock = false;

  const emitBuffer = (): RunEvent | null => {
    const text = textBuffer.trim();
    textBuffer = "";
    return text.length > 0 ? progressEvent(runId, text) : null;
  };

  for await (const line of logs) {
    const msg = parsePiStreamLine(line, runId);
    if (!msg) continue;

    // Text-delta-style progress streaming — accumulate short chunks and
    // flush on fence / size threshold. Only plain text messages without
    // structured `data` go through this path; structured events flush
    // the buffer first and then pass through unchanged.
    const isPlainProgress =
      msg.type === "appstrate.progress" &&
      msg.message !== undefined &&
      msg.data === undefined &&
      msg.level === undefined;

    if (isPlainProgress) {
      textBuffer += String(msg.message ?? "");

      if (inCodeBlock) {
        const closeIdx = textBuffer.indexOf("```");
        if (closeIdx !== -1) {
          inCodeBlock = false;
          textBuffer = textBuffer.substring(closeIdx + 3);
        } else {
          textBuffer = "";
        }
        continue;
      }

      const fenceIdx = textBuffer.indexOf("```");
      if (fenceIdx !== -1) {
        const before = textBuffer.substring(0, fenceIdx);
        textBuffer = before;
        const flushed = emitBuffer();
        if (flushed) yield flushed;
        inCodeBlock = true;
        textBuffer = "";
        continue;
      }

      if (textBuffer.length >= 300 && !textBuffer.endsWith("`") && !textBuffer.endsWith("``")) {
        const flushed = emitBuffer();
        if (flushed) yield flushed;
      }
      continue;
    }

    const flushed = emitBuffer();
    if (flushed) yield flushed;

    yield msg;
  }

  const remaining = emitBuffer();
  if (remaining) yield remaining;
}

/** @internal Exported for testing */
export { processPiLogs as _processPiLogsForTesting };

/** @internal Exported for testing */
export { deriveKeyPlaceholder as _deriveKeyPlaceholderForTesting };

/** @internal Exported for testing */
export function parsePiStreamLine(line: string, runId: string): RunEvent | null {
  try {
    const obj = JSON.parse(line);

    switch (obj.type) {
      case "text_delta":
        return progressEvent(runId, String(obj.text ?? ""));

      case "assistant_message":
        return null;

      case "output":
        return {
          type: "output.emitted",
          timestamp: Date.now(),
          runId,
          data: obj.data,
        };

      case "report":
        return {
          type: "report.appended",
          timestamp: Date.now(),
          runId,
          content: String(obj.content ?? ""),
        };

      case "set_state":
        return {
          type: "state.set",
          timestamp: Date.now(),
          runId,
          state: obj.state,
        };

      case "add_memory":
        return {
          type: "memory.added",
          timestamp: Date.now(),
          runId,
          content: String(obj.content ?? ""),
        };

      case "tool_start":
        return progressEvent(runId, `Tool: ${obj.name ?? "unknown"}`, {
          data: { tool: obj.name, args: obj.args },
        });

      case "tool_end":
        return null;

      case "usage": {
        const t = obj.tokens || {};
        return {
          type: "appstrate.metric",
          timestamp: Date.now(),
          runId,
          usage: {
            input_tokens: t.input ?? 0,
            output_tokens: t.output ?? 0,
            cache_creation_input_tokens: t.cacheWrite ?? 0,
            cache_read_input_tokens: t.cacheRead ?? 0,
          },
          cost: typeof obj.cost === "number" ? obj.cost : undefined,
        };
      }

      case "agent_end":
        return null;

      case "error":
        return {
          type: "appstrate.error",
          timestamp: Date.now(),
          runId,
          message: String(obj.message ?? "unknown error"),
        };

      case "log": {
        const validLevels = ["debug", "info", "warn", "error"] as const;
        const level = (validLevels as readonly string[]).includes(obj.level) ? obj.level : "info";
        return progressEvent(runId, String(obj.message ?? ""), {
          data: obj.data,
          level,
        });
      }

      default:
        return null;
    }
  } catch {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    return progressEvent(runId, `[container] ${trimmed}`);
  }
}

function progressEvent(
  runId: string,
  message: string,
  extra?: { data?: unknown; level?: string },
): RunEvent {
  const event: RunEvent = {
    type: "appstrate.progress",
    timestamp: Date.now(),
    runId,
    message,
  };
  if (extra?.data !== undefined) event.data = extra.data;
  if (extra?.level !== undefined) event.level = extra.level;
  return event;
}
