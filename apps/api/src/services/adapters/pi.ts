import { logger } from "../../lib/logger.ts";
import type { ExecutionAdapter, ExecutionMessage, PromptContext } from "./types.ts";
import { buildEnrichedPrompt, extractJsonResult } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import {
  createContainer,
  createNetwork,
  getContainerIp,
  startContainer,
  stopContainer,
  removeContainer,
  removeNetwork,
} from "../docker.ts";

const PI_RUNTIME_IMAGE = "appstrate-pi:latest";
const SIDECAR_IMAGE = "appstrate-sidecar:latest";
const SIDECAR_HEALTH_RETRIES = 3;
const SIDECAR_HEALTH_DELAY_MS = 500;

async function waitForSidecarHealth(
  sidecarContainerId: string,
  networkName: string,
): Promise<void> {
  const ip = await getContainerIp(sidecarContainerId, networkName);
  if (!ip) {
    throw new Error("Sidecar has no IP on the execution network");
  }

  for (let attempt = 1; attempt <= SIDECAR_HEALTH_RETRIES; attempt++) {
    try {
      const res = await fetch(`http://${ip}:8080/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      // Retry
    }
    if (attempt < SIDECAR_HEALTH_RETRIES) {
      await new Promise((r) => setTimeout(r, SIDECAR_HEALTH_DELAY_MS));
    }
  }
  throw new Error("Sidecar health check failed after retries");
}

export class PiAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    ctx: PromptContext,
    timeout: number,
    flowPackage?: Buffer,
    signal?: AbortSignal,
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(ctx);

    const provider = process.env.LLM_PROVIDER || "anthropic";
    const modelId = process.env.LLM_MODEL_ID || ctx.llmModel;

    const networkName = `appstrate-exec-${executionId}`;
    let networkId: string | undefined;
    let sidecarContainerId: string | undefined;

    try {
      // 1. Create isolated network
      networkId = await createNetwork(networkName);

      // 2. Create sidecar directly on custom network with host access
      const sidecarEnv: Record<string, string> = { PORT: "8080" };
      if (ctx.executionApi) {
        sidecarEnv.EXECUTION_TOKEN = ctx.executionApi.token;
        sidecarEnv.PLATFORM_API_URL = ctx.executionApi.url;
      }

      sidecarContainerId = await createContainer(executionId, sidecarEnv, {
        image: SIDECAR_IMAGE,
        adapterName: "sidecar",
        memory: 256 * 1024 * 1024,
        nanoCpus: 500_000_000,
        networkId,
        networkAlias: "sidecar",
        extraHosts: ["host.docker.internal:host-gateway"],
      });

      // 3. Start sidecar and wait for health
      await startContainer(sidecarContainerId);
      await waitForSidecarHealth(sidecarContainerId, networkName);

      // 4. Build agent env — NO EXECUTION_TOKEN, NO PLATFORM_API_URL, NO ExtraHosts
      const containerEnv: Record<string, string> = {
        FLOW_PROMPT: prompt,
        LLM_PROVIDER: provider,
        LLM_MODEL_ID: modelId,
        SIDECAR_URL: "http://sidecar:8080",
      };

      const connectedServiceIds = ctx.services.filter((s) => ctx.tokens[s.id]).map((s) => s.id);
      if (connectedServiceIds.length > 0) {
        containerEnv.CONNECTED_SERVICES = connectedServiceIds.join(",");
      }

      for (const key of API_KEY_ENV_VARS) {
        if (process.env[key]) containerEnv[key] = process.env[key]!;
      }

      // 5. Create agent on the custom network ONLY
      const containerId = await createContainer(executionId, containerEnv, {
        image: PI_RUNTIME_IMAGE,
        adapterName: "pi",
        networkId,
        networkAlias: "agent",
      });

      // 6. Run container lifecycle
      yield* runContainerLifecycle({
        containerId,
        adapterName: "pi",
        executionId,
        timeout,
        flowPackage,
        extraData: { provider, model: modelId },
        signal,
        stopOnTimeout: sidecarContainerId ? [sidecarContainerId] : [],
        processLogs: processPiLogs,
      });
    } finally {
      // Cleanup sidecar + network (idempotent — 404 is OK)
      if (sidecarContainerId) {
        await stopContainer(sidecarContainerId).catch((err) => {
          logger.error("Failed to stop sidecar", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        await removeContainer(sidecarContainerId).catch((err) => {
          logger.error("Failed to remove sidecar", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (networkId) {
        await removeNetwork(networkId).catch((err) => {
          logger.error("Failed to remove network", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }
}

// --- Constants & helpers ---

const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "DEEPSEEK_API_KEY",
];

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

    if (msg.type === "progress" && !msg.data) {
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

function parsePiStreamLine(line: string): ExecutionMessage | null {
  try {
    const obj = JSON.parse(line);

    switch (obj.type) {
      case "text_delta":
        return { type: "progress", message: obj.text || "" };

      case "assistant_message": {
        const text = obj.text || "";
        const jsonResult = extractJsonResult(text);
        if (jsonResult) {
          return { type: "result", data: jsonResult };
        }
        return null;
      }

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
          type: "result",
          usage: {
            input_tokens: t.input ?? 0,
            output_tokens: t.output ?? 0,
            cache_creation_input_tokens: t.cacheWrite ?? 0,
            cache_read_input_tokens: t.cacheRead ?? 0,
            cost_usd: typeof obj.cost === "number" ? obj.cost : undefined,
          },
        };
      }

      case "agent_end":
        return null;

      case "error":
        return { type: "progress", message: `Error: ${obj.message || "unknown error"}` };

      default:
        return null;
    }
  } catch {
    return null;
  }
}
