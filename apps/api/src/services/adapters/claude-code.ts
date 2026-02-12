import type { FlowOutputField } from "@appstrate/shared-types";
import type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
import {
  createClaudeCodeContainer,
  startContainer,
  streamLogs,
  waitForExit,
  stopContainer,
  removeContainer,
} from "../docker.ts";

export class ClaudeCodeAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    envVars: Record<string, string>,
    flowPath: string,
    timeout: number,
    outputSchema?: Record<string, FlowOutputField>,
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

    for (const [k, v] of Object.entries(envVars)) {
      if (
        k.startsWith("TOKEN_") ||
        k.startsWith("CONFIG_") ||
        k.startsWith("INPUT_") ||
        k === "FLOW_STATE"
      ) {
        containerEnv[k] = v;
      }
    }

    // Create and start the container
    const containerId = await createClaudeCodeContainer(executionId, containerEnv, flowPath);

    yield {
      type: "progress",
      message: "Claude Code container started",
      data: { adapter: "claude-code", executionId, containerId },
    };

    await startContainer(containerId);

    // Timeout: stop the container if it exceeds the limit
    const timeoutMs = timeout * 1000;
    let timedOut = false;
    const timeoutHandle = setTimeout(async () => {
      timedOut = true;
      await stopContainer(containerId).catch(() => {});
    }, timeoutMs);

    let hasResult = false;

    try {
      for await (const line of streamLogs(containerId)) {
        const msg = parseStreamJsonLine(line);
        if (msg) {
          if (msg.type === "result") hasResult = true;
          yield msg;
        }
      }

      const exitCode = await waitForExit(containerId);

      if (timedOut) {
        throw new TimeoutError(`Execution timed out after ${timeout}s`);
      }

      // Only throw on non-zero exit if we didn't get a result
      if (exitCode !== 0 && !hasResult) {
        throw new Error(`Claude Code container exited with code ${exitCode}`);
      }
    } finally {
      clearTimeout(timeoutHandle);
      await removeContainer(containerId).catch((err) => {
        console.error(`[adapter] Failed to remove container ${containerId}:`, err);
      });
    }
  }
}

function buildEnrichedPrompt(
  envVars: Record<string, string>,
  outputSchema?: Record<string, FlowOutputField>,
): string {
  const flowPrompt = envVars.FLOW_PROMPT || "";

  const tokenEntries = Object.entries(envVars).filter(([k]) => k.startsWith("TOKEN_"));
  const configEntries = Object.entries(envVars).filter(([k]) => k.startsWith("CONFIG_"));
  const inputEntries = Object.entries(envVars).filter(([k]) => k.startsWith("INPUT_"));

  const sections: string[] = [];

  // API access instructions
  if (tokenEntries.length > 0) {
    sections.push("## API Access\n");
    sections.push(
      "You have OAuth tokens available as environment variables. Use them with curl via Bash.\n",
    );

    for (const [key, _] of tokenEntries) {
      const svcName = key.replace("TOKEN_", "").toLowerCase();
      sections.push(`- **${svcName}**: \`$${key}\``);

      if (svcName === "gmail") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20"\``,
        );
        sections.push(
          `  Get message: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full"\``,
        );
      } else if (svcName === "clickup") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://api.clickup.com/api/v2/team"\``,
        );
        sections.push(
          `  Create task: \`curl -s -X POST -H "Authorization: Bearer $${key}" -H "Content-Type: application/json" -d '{"name":"...","description":"..."}' "https://api.clickup.com/api/v2/list/{list_id}/task"\``,
        );
      } else if (svcName === "facebook") {
        sections.push(
          `  List Pages: \`curl -s -H "Authorization: Bearer $${key}" "https://graph.facebook.com/v21.0/me/accounts"\``,
        );
        sections.push(
          `  Post to Page: \`curl -s -X POST "https://graph.facebook.com/v21.0/{page_id}/feed" -H "Content-Type: application/json" -d '{"message":"...","access_token":"PAGE_ACCESS_TOKEN"}'\``,
        );
        sections.push(
          `  Note: Use the Page Access Token from /me/accounts (not $${key}) when posting to a Page.`,
        );
      }
    }
    sections.push("");
  }

  // User input for this execution
  if (inputEntries.length > 0) {
    sections.push("## User Input\n");
    for (const [key, value] of inputEntries) {
      const name = key.replace("INPUT_", "").toLowerCase();
      sections.push(`- **${name}**: ${value}`);
    }
    sections.push("");
  }

  // Config
  if (configEntries.length > 0) {
    sections.push("## Configuration\n");
    for (const [key, value] of configEntries) {
      const name = key.replace("CONFIG_", "").toLowerCase();
      sections.push(`- **${name}**: ${value}`);
    }
    sections.push("");
  }

  // State
  if (envVars.FLOW_STATE && envVars.FLOW_STATE !== "{}") {
    sections.push("## Previous State\n");
    sections.push("```json");
    sections.push(envVars.FLOW_STATE);
    sections.push("```\n");
  }

  // Output format
  sections.push("## Output Format\n");
  sections.push(
    "When you have completed the task, output your final result as a JSON object inside a ```json code block.",
  );

  if (outputSchema && Object.keys(outputSchema).length > 0) {
    sections.push("\nThe JSON must include the following fields:");
    const example: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(outputSchema)) {
      const req = field.required ? "required" : "optional";
      sections.push(`- **${key}** (${field.type}, ${req}): ${field.description}`);
      // Build example value based on type
      if (field.type === "string") example[key] = "...";
      else if (field.type === "number") example[key] = 0;
      else if (field.type === "boolean") example[key] = false;
      else if (field.type === "array") example[key] = [];
      else if (field.type === "object") example[key] = {};
    }
    sections.push("\nExample:");
    sections.push("```json");
    sections.push(JSON.stringify(example, null, 2));
    sections.push("```");
  } else {
    sections.push("The JSON must contain at minimum a `summary` field (string).");
    sections.push("Example:");
    sections.push("```json");
    sections.push(
      JSON.stringify(
        {
          summary: "Processed 5 emails, created 3 tickets",
          tickets_created: [],
          state: { last_run: "2025-01-01T00:00:00Z" },
        },
        null,
        2,
      ),
    );
    sections.push("```");
  }

  sections.push(
    "\nIf you need to update persistent state for the next run, include a `state` object.\n",
  );

  const preamble = sections.length > 0 ? sections.join("\n") + "\n---\n\n" : "";
  return preamble + flowPrompt;
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

function extractJsonResult(text: string): Record<string, unknown> | null {
  // Look for ```json ... ``` blocks (last one wins)
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1]!;
    try {
      return JSON.parse(lastMatch[1]!.trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function buildRetryPrompt(
  badResult: Record<string, unknown>,
  validationErrors: string[],
  outputSchema: Record<string, FlowOutputField>,
): string {
  const lines: string[] = [];

  lines.push("# Output Correction Required\n");
  lines.push(
    "Your previous output did not match the required schema. Fix the JSON and return ONLY a corrected ```json block.\n",
  );

  lines.push("## Your Previous Output\n");
  lines.push("```json");
  lines.push(JSON.stringify(badResult, null, 2));
  lines.push("```\n");

  lines.push("## Validation Errors\n");
  for (const err of validationErrors) {
    lines.push(`- ${err}`);
  }
  lines.push("");

  lines.push("## Expected Schema\n");
  for (const [key, field] of Object.entries(outputSchema)) {
    const req = field.required ? "required" : "optional";
    lines.push(`- **${key}** (${field.type}, ${req}): ${field.description}`);
  }
  lines.push("");

  lines.push("## Instructions\n");
  lines.push(
    "Return ONLY a single ```json code block with the corrected JSON. Do not include any explanation or commentary.",
  );

  return lines.join("\n");
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
