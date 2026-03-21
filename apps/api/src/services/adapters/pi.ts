import { logger } from "../../lib/logger.ts";
import type { ExecutionAdapter, ExecutionMessage, PromptContext, UploadedFile } from "./types.ts";
import { buildEnrichedPrompt } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import { sanitizeStorageKey } from "../file-storage.ts";
import {
  getOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";

import { getEnv } from "@appstrate/env";

export class PiAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    ctx: PromptContext,
    timeout: number,
    flowPackage?: Buffer,
    signal?: AbortSignal,
    inputFiles?: UploadedFile[],
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(ctx);

    const llmConfig = ctx.llmConfig;
    const modelId = llmConfig.modelId;

    const orchestrator = getOrchestrator();
    let boundary: IsolationBoundary | undefined;
    let sidecarHandle: WorkloadHandle | undefined;

    try {
      // Phase 1: Create isolation boundary
      boundary = await orchestrator.createIsolationBoundary(executionId);

      // Resolve LLM config for sidecar proxy
      const llmApiKey = llmConfig.apiKey;
      const llmPlaceholder = deriveKeyPlaceholder(llmApiKey);

      // Sidecar config (platform network resolution handled by orchestrator)
      const sidecarConfig = {
        executionToken: ctx.executionApi?.token ?? "",
        platformApiUrl: ctx.executionApi?.url ?? "",
        proxyUrl: ctx.proxyUrl ?? undefined,
        llm: llmApiKey
          ? { baseUrl: llmConfig.baseUrl, apiKey: llmApiKey, placeholder: llmPlaceholder }
          : undefined,
      };

      // Build agent env — NO EXECUTION_TOKEN, NO PLATFORM_API_URL, NO ExtraHosts
      const containerEnv: Record<string, string> = {
        FLOW_PROMPT: prompt,
        MODEL_API: llmConfig.api,
        MODEL_ID: modelId,
        SIDECAR_URL: "http://sidecar:8080",
      };

      const connectedProviderIds = ctx.providers.filter((s) => ctx.tokens[s.id]).map((s) => s.id);
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

      // Disable structured_output tool when no output schema is defined
      const hasOutputSchema =
        ctx.schemas.output?.properties && Object.keys(ctx.schemas.output.properties).length > 0;
      if (!hasOutputSchema) {
        containerEnv.DISABLED_TOOLS = "structured-output";
      }

      // All outbound HTTP traffic routed through sidecar forward proxy.
      // The execution network is internal (no NAT) — clients that ignore
      // HTTP_PROXY simply get connection failures, which is the desired behavior.
      containerEnv.HTTP_PROXY = "http://sidecar:8081";
      containerEnv.HTTPS_PROXY = "http://sidecar:8081";
      containerEnv.http_proxy = "http://sidecar:8081";
      containerEnv.https_proxy = "http://sidecar:8081";
      containerEnv.NO_PROXY = "sidecar,localhost,127.0.0.1";
      containerEnv.no_proxy = "sidecar,localhost,127.0.0.1";

      // Prepare files for batch injection into agent
      const filesToInject: Array<{ name: string; content: Buffer }> = [];
      if (flowPackage) {
        filesToInject.push({ name: "flow-package.afps", content: flowPackage });
      }
      if (inputFiles) {
        for (const f of inputFiles) {
          filesToInject.push({
            name: `documents/${sanitizeStorageKey(f.name)}`,
            content: f.buffer,
          });
        }
      }

      // Phase 2: Setup sidecar + create agent (parallel)
      const [sidecar, agent] = await Promise.all([
        orchestrator.createSidecar(executionId, boundary, sidecarConfig),
        orchestrator.createWorkload(
          {
            executionId,
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
        executionId,
        timeout,
        extraData: { api: llmConfig.api, model: modelId },
        signal,
        stopOnTimeout: [sidecarHandle],
        processLogs: processPiLogs,
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

async function* processPiLogs(logs: AsyncGenerator<string>): AsyncGenerator<ExecutionMessage> {
  let textBuffer = "";
  let inCodeBlock = false;

  const emitBuffer = (): ExecutionMessage | null => {
    const text = textBuffer.trim();
    textBuffer = "";
    return text.length > 0 ? { type: "progress", message: text } : null;
  };

  for await (const line of logs) {
    const msg = parsePiStreamLine(line);
    if (!msg) continue;

    if (msg.type === "progress" && !msg.data && !msg.level) {
      textBuffer += msg.message ?? "";

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
export function parsePiStreamLine(line: string): ExecutionMessage | null {
  try {
    const obj = JSON.parse(line);

    switch (obj.type) {
      case "text_delta":
        return { type: "progress", message: obj.text || "" };

      case "assistant_message":
        return null;

      case "report":
        return { type: obj.final ? "report_final" : "report", content: obj.content || "" };

      case "structured_output":
        return { type: "structured_output", data: obj.data };

      case "set_state":
        return { type: "set_state", data: obj.state };

      case "add_memory":
        return { type: "add_memory", content: obj.content || "" };

      case "tool_start":
        return {
          type: "progress",
          message: `Tool: ${obj.name || "unknown"}`,
          data: { tool: obj.name, args: obj.args },
        };

      case "tool_end":
        return null;

      case "usage": {
        const t = obj.tokens || {};
        return {
          type: "usage",
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
        return { type: "error", message: obj.message || "unknown error" };

      case "log": {
        const validLevels = ["debug", "info", "warn", "error"];
        return {
          type: "progress",
          message: obj.message || "",
          data: obj.data ?? undefined,
          level: validLevels.includes(obj.level) ? obj.level : "info",
        };
      }

      default:
        return null;
    }
  } catch {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    return { type: "progress", message: `[container] ${trimmed}` };
  }
}
