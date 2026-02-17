import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
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
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(envVars, outputSchema);
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
          const msg = parseStreamJsonLine(line);
          if (msg) yield msg;
        }
      },
    });
  }
}

function parseStreamJsonLine(line: string): ExecutionMessage | null {
  try {
    const obj = JSON.parse(line);

    // assistant message with text content → progress
    if (obj.type === "assistant" && obj.message?.content) {
      const textParts = obj.message.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);

      if (textParts.length > 0) {
        const text = textParts.join("\n");

        // Check if the text contains a final JSON result block
        const jsonResult = extractJsonResult(text);
        if (jsonResult) {
          return { type: "result", data: jsonResult };
        }

        return { type: "progress", message: text };
      }

      return null;
    }

    // result type → extract result text and parse JSON
    if (obj.type === "result") {
      const resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result);
      const jsonResult = extractJsonResult(resultText);
      if (jsonResult) {
        return { type: "result", data: jsonResult };
      }
      // If no JSON block found, wrap the text as summary
      return { type: "result", data: { summary: resultText } };
    }

    // system message or other → ignore
    return null;
  } catch {
    // Not JSON → ignore
    return null;
  }
}
