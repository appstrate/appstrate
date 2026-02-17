import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
import { buildEnrichedPrompt, extractJsonResult, filterFlowEnvVars } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import { createContainer } from "../docker.ts";

const PI_RUNTIME_IMAGE = "appstrate-pi:latest";

export class PiAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    envVars: Record<string, string>,
    timeout: number,
    outputSchema?: JSONSchemaObject,
    flowPackage?: Buffer,
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(envVars, outputSchema);

    // Resolve LLM provider + model from env
    const provider = process.env.LLM_PROVIDER || "anthropic";
    const modelId = process.env.LLM_MODEL_ID || envVars.LLM_MODEL || "claude-sonnet-4-5-20250929";

    // Build container environment variables
    const containerEnv: Record<string, string> = {
      FLOW_PROMPT: prompt,
      LLM_PROVIDER: provider,
      LLM_MODEL_ID: modelId,
    };

    // Forward provider API keys from host environment
    const apiKeyEnvVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "TOGETHER_API_KEY",
      "DEEPSEEK_API_KEY",
    ];
    for (const key of apiKeyEnvVars) {
      if (process.env[key]) {
        containerEnv[key] = process.env[key]!;
      }
    }

    // Forward flow-specific env vars
    filterFlowEnvVars(envVars, containerEnv);

    // Create the container
    const containerId = await createContainer(executionId, containerEnv, {
      image: PI_RUNTIME_IMAGE,
      adapterName: "pi",
    });

    yield* runContainerLifecycle({
      containerId,
      adapterName: "pi",
      executionId,
      timeout,
      flowPackage,
      extraData: { provider, model: modelId },
      processLogs: async function* (logs) {
        // Buffer text_delta tokens into larger chunks before yielding.
        // Code blocks (``` ... ```) are suppressed (the JSON result is
        // already captured by the assistant_message → extractJsonResult path).
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

            // Inside code block — discard until closing ```
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

            // Check for code fence (```) in the accumulated buffer
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

            // Flush when the buffer is large enough.
            // Skip flush if buffer ends with backtick(s) (partial fence).
            if (textBuffer.length >= 300 && !textBuffer.endsWith("`") && !textBuffer.endsWith("``")) {
              const flushed = emitBuffer();
              if (flushed) yield flushed;
            }
            continue;
          }

          // Non-text message (result, tool_start, etc.) — flush buffer first
          const flushed = emitBuffer();
          if (flushed) yield flushed;

          yield msg;
        }

        // Flush any remaining text
        const remaining = emitBuffer();
        if (remaining) yield remaining;
      },
    });
  }
}

function parsePiStreamLine(line: string): ExecutionMessage | null {
  try {
    const obj = JSON.parse(line);

    switch (obj.type) {
      case "text_delta":
        return { type: "progress", message: obj.text || "" };

      case "assistant_message": {
        // Text was already streamed via text_delta — only use this for JSON result extraction
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

      case "agent_end":
        return null;

      case "error":
        return { type: "progress", message: `Error: ${obj.message || "unknown error"}` };

      default:
        return null;
    }
  } catch {
    // Not JSON → ignore
    return null;
  }
}
