import { logger } from "../../lib/logger.ts";
import type { ExecutionAdapter, ExecutionMessage, PromptContext, UploadedFile } from "./types.ts";
import { buildEnrichedPrompt, extractJsonResult } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import { getEnv, LLM_API_KEY_NAMES } from "@appstrate/env";
import { sanitizeStorageKey } from "../file-storage.ts";
import {
  connectContainerToNetwork,
  createContainer,
  createNetwork,
  detectPlatformNetwork,
  execInContainer,
  injectFiles,
  startContainer,
  stopContainer,
  removeContainer,
  removeNetwork,
} from "../docker.ts";
import { acquireSidecar } from "../sidecar-pool.ts";

const PI_RUNTIME_IMAGE = "appstrate-pi:latest";
const SIDECAR_IMAGE = "appstrate-sidecar:latest";
const SIDECAR_HEALTH_RETRIES = 20;
const SIDECAR_HEALTH_DELAY_MS = 100;

async function waitForSidecarHealth(sidecarContainerId: string): Promise<void> {
  for (let attempt = 1; attempt <= SIDECAR_HEALTH_RETRIES; attempt++) {
    try {
      const exitCode = await execInContainer(sidecarContainerId, [
        "bun",
        "-e",
        "const r = await fetch('http://localhost:8080/health'); process.exit(r.ok ? 0 : 1)",
      ]);
      if (exitCode === 0) return;
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
    inputFiles?: UploadedFile[],
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(ctx);

    const apiEnv = getEnv();
    const provider = apiEnv.LLM_PROVIDER;
    const modelId = apiEnv.LLM_MODEL_ID;

    const networkName = `appstrate-exec-${executionId}`;
    let networkId: string | undefined;
    let sidecarContainerId: string | undefined;

    try {
      // Phase 1: Create network + detect platform network (parallel)
      const [netId, platformNetwork] = await Promise.all([
        createNetwork(networkName),
        detectPlatformNetwork(),
      ]);
      networkId = netId;

      // Single source of truth for sidecar configuration
      const sidecarConfig = {
        executionToken: ctx.executionApi?.token ?? "",
        platformApiUrl: ctx.executionApi
          ? platformNetwork
            ? `http://${platformNetwork.hostname}:${apiEnv.PORT}`
            : ctx.executionApi.url
          : "",
        proxyUrl: ctx.proxyUrl ?? undefined,
      };

      // Env vars representation (for fresh sidecar creation fallback)
      const sidecarEnv: Record<string, string> = { PORT: "8080" };
      if (sidecarConfig.executionToken) {
        sidecarEnv.EXECUTION_TOKEN = sidecarConfig.executionToken;
        sidecarEnv.PLATFORM_API_URL = sidecarConfig.platformApiUrl;
      }
      if (sidecarConfig.proxyUrl) {
        sidecarEnv.PROXY_URL = sidecarConfig.proxyUrl;
      }

      // Build agent env — NO EXECUTION_TOKEN, NO PLATFORM_API_URL, NO ExtraHosts
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

      for (const key of LLM_API_KEY_NAMES) {
        const val = apiEnv[key];
        if (val) containerEnv[key] = val;
      }

      if (ctx.proxyUrl) {
        containerEnv.HTTP_PROXY = ctx.proxyUrl;
        containerEnv.HTTPS_PROXY = ctx.proxyUrl;
        containerEnv.http_proxy = ctx.proxyUrl;
        containerEnv.https_proxy = ctx.proxyUrl;
        containerEnv.NO_PROXY = "sidecar,localhost,127.0.0.1";
        containerEnv.no_proxy = "sidecar,localhost,127.0.0.1";
      }

      // Prepare files for batch injection into agent
      const filesToInject: Array<{ name: string; content: Buffer }> = [];
      if (flowPackage) {
        filesToInject.push({ name: "flow-package.zip", content: flowPackage });
      }
      if (inputFiles) {
        for (const f of inputFiles) {
          filesToInject.push({
            name: `documents/${sanitizeStorageKey(f.name)}`,
            content: f.buffer,
          });
        }
      }

      // Phase 2: Setup sidecar + create agent + inject files (parallel)
      // The sidecar path (pool or fresh) runs concurrently with agent creation + file injection.
      const sidecarSetup = async (): Promise<string> => {
        // Try pool first (pre-warmed sidecar: ~50-130ms)
        const pooled = await acquireSidecar(
          executionId,
          networkId!,
          sidecarConfig,
          platformNetwork,
        );
        if (pooled) return pooled;

        // Fallback: create fresh sidecar (~500-1500ms)
        const id = await createContainer(executionId, sidecarEnv, {
          image: SIDECAR_IMAGE,
          adapterName: "sidecar",
          memory: 256 * 1024 * 1024,
          nanoCpus: 500_000_000,
          networkId: networkId!,
          networkAlias: "sidecar",
          extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"],
        });

        if (platformNetwork) {
          await connectContainerToNetwork(platformNetwork.networkId, id);
        }

        await startContainer(id);
        await waitForSidecarHealth(id);
        return id;
      };

      const agentSetup = async (): Promise<string> => {
        const id = await createContainer(executionId, containerEnv, {
          image: PI_RUNTIME_IMAGE,
          adapterName: "pi",
          networkId: networkId!,
          networkAlias: "agent",
        });

        // Inject files while sidecar is starting
        if (filesToInject.length > 0) {
          await injectFiles(id, filesToInject, "/workspace");
        }

        return id;
      };

      // Run both in parallel — agent creation + file injection overlaps with sidecar startup
      const [sidecarId, containerId] = await Promise.all([sidecarSetup(), agentSetup()]);
      sidecarContainerId = sidecarId;

      // Phase 3: Run agent container lifecycle (start + stream + wait + cleanup)
      // Files are already injected above — pass no files to runContainerLifecycle
      yield* runContainerLifecycle({
        containerId,
        adapterName: "pi",
        executionId,
        timeout,
        // flowPackage/inputFiles already injected in agentSetup
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

// --- Helpers ---

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
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    return { type: "progress", message: `[container] ${trimmed}` };
  }
}
