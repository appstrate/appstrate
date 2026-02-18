import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { ExecutionAdapter, ExecutionMessage, FileReference } from "./types.ts";
import { buildEnrichedPrompt, extractJsonResult, filterFlowEnvVars } from "./prompt-builder.ts";
import { runContainerLifecycle } from "./container-lifecycle.ts";
import { createContainer } from "../docker.ts";

const CLAUDE_CODE_RUNTIME_IMAGE = "appstrate-claude-code:latest";

export class ClaudeCodeAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    envVars: Record<string, string>,
    timeout: number,
    outputSchema?: JSONSchemaObject,
    flowPackage?: Buffer,
    files?: FileReference[],
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(envVars, outputSchema, files);
    const model = envVars.LLM_MODEL || "claude-sonnet-4-5-20250929";

    // Auth via CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, uses Claude subscription)
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
      throw new Error(
        "CLAUDE_CODE_OAUTH_TOKEN is required for the claude-code adapter. Run `claude setup-token` to generate one.",
      );
    }

    // Build container environment variables
    const containerEnv: Record<string, string> = {
      FLOW_PROMPT: prompt,
      LLM_MODEL: model,
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    };

    filterFlowEnvVars(envVars, containerEnv);

    // Create the container
    const containerId = await createContainer(executionId, containerEnv, {
      image: CLAUDE_CODE_RUNTIME_IMAGE,
      adapterName: "cc",
    });

    yield* runContainerLifecycle({
      containerId,
      adapterName: "claude-code",
      executionId,
      timeout,
      flowPackage,
      processLogs: async function* (logs) {
        for await (const line of logs) {
          for (const msg of parseStreamJsonLine(line)) {
            yield msg;
          }
        }
      },
    });
  }
}

function parseStreamJsonLine(line: string): ExecutionMessage[] {
  try {
    const obj = JSON.parse(line);

    // assistant message with text + tool_use content → progress
    if (obj.type === "assistant" && obj.message?.content) {
      const messages: ExecutionMessage[] = [];

      for (const block of obj.message.content) {
        if (block.type === "text" && block.text) {
          const jsonResult = extractJsonResult(block.text);
          if (jsonResult) {
            return [{ type: "result", data: jsonResult }];
          }
          messages.push({ type: "progress", message: block.text });
        } else if (block.type === "tool_use" && block.name) {
          messages.push({
            type: "progress",
            message: `Tool: ${block.name}`,
            data: { tool: block.name, args: block.input },
          });
        }
      }

      return messages;
    }

    // result type → extract result text and parse JSON
    if (obj.type === "result") {
      const resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result);
      const jsonResult = extractJsonResult(resultText);

      // Extract token usage from result event
      let usage: import("./types.ts").TokenUsage | undefined;
      if (obj.usage) {
        usage = {
          input_tokens: obj.usage.input_tokens ?? 0,
          output_tokens: obj.usage.output_tokens ?? 0,
          cache_creation_input_tokens: obj.usage.cache_creation_input_tokens,
          cache_read_input_tokens: obj.usage.cache_read_input_tokens,
          cost_usd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        };
      }

      if (jsonResult) {
        return [{ type: "result", data: jsonResult, usage }];
      }
      // If no JSON block found, wrap the text as summary
      return [{ type: "result", data: { summary: resultText }, usage }];
    }

    // system message or other → ignore
    return [];
  } catch {
    // Not JSON → ignore
    return [];
  }
}
