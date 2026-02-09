import type { ExecutionAdapter, ExecutionMessage } from "./types.ts";

const DEFAULT_CLI_PATH = process.env.CLAUDE_CLI_PATH || "claude";

export class ClaudeCodeAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    envVars: Record<string, string>,
    _flowPath: string,
    timeout: number,
  ): AsyncGenerator<ExecutionMessage> {
    const prompt = buildEnrichedPrompt(envVars);
    const model = envVars.LLM_MODEL || "claude-sonnet-4-5-20250929";

    // Pass prompt via stdin (not as CLI arg) to avoid length/encoding issues
    const cliArgs = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--allowedTools", "Bash(read_only=false) WebFetch WebSearch",
      "--model", model,
      "--max-turns", "50",
      "--system-prompt", "You are an AI assistant executing a flow. Follow the user instructions precisely. Use Bash with curl for API calls. Output your final result as JSON in a ```json code block.",
      "--disable-slash-commands",
    ];

    // Auth via CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, uses Claude subscription)
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
      throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for the claude-code adapter. Run `claude setup-token` to generate one.");
    }

    const flowVarArgs: string[] = [
      `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`,
    ];
    for (const [k, v] of Object.entries(envVars)) {
      if (k.startsWith("TOKEN_") || k.startsWith("CONFIG_") || k.startsWith("INPUT_") || k === "FLOW_STATE") {
        flowVarArgs.push(`${k}=${v}`);
      }
    }

    // Use `env` to: set CLAUDE_CODE_OAUTH_TOKEN + flow vars, unset ANTHROPIC_API_KEY (avoid conflict)
    const spawnCmd = [
      "env",
      "-u", "ANTHROPIC_API_KEY",
      ...flowVarArgs,
      DEFAULT_CLI_PATH,
      ...cliArgs,
    ];

    yield { type: "progress", message: "Claude Code CLI started", data: { adapter: "claude-code", executionId } };

    // Don't pass env — let Bun.spawn inherit the real OS environment
    // Pipe prompt via stdin to avoid arg length/encoding issues
    // cwd=/tmp avoids loading CLAUDE.md from the project directory
    const proc = Bun.spawn(spawnCmd, {
      cwd: "/tmp",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write prompt to stdin and close
    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeoutMs = timeout * 1000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    // Collect stderr in background to avoid pipe deadlock
    const stderrPromise = new Response(proc.stderr).text();
    let hasResult = false;

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const msg = parseStreamJsonLine(trimmed);
          if (msg) {
            if (msg.type === "result") hasResult = true;
            yield msg;
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        const msg = parseStreamJsonLine(buffer.trim());
        if (msg) {
          if (msg.type === "result") hasResult = true;
          yield msg;
        }
      }

      reader.releaseLock();
    } finally {
      clearTimeout(timeoutHandle);
    }

    await proc.exited;
    const stderrText = await stderrPromise;

    if (timedOut) {
      throw new ClaudeCodeTimeoutError(`Execution timed out after ${timeout}s`);
    }

    // Only throw on non-zero exit if we didn't get a result
    if (proc.exitCode !== 0 && !hasResult) {
      throw new Error(`Claude Code CLI exited with code ${proc.exitCode}: ${stderrText.slice(0, 500)}`);
    }
  }
}

function buildEnrichedPrompt(envVars: Record<string, string>): string {
  const flowPrompt = envVars.FLOW_PROMPT || "";

  const tokenEntries = Object.entries(envVars).filter(([k]) => k.startsWith("TOKEN_"));
  const configEntries = Object.entries(envVars).filter(([k]) => k.startsWith("CONFIG_"));
  const inputEntries = Object.entries(envVars).filter(([k]) => k.startsWith("INPUT_"));

  const sections: string[] = [];

  // API access instructions
  if (tokenEntries.length > 0) {
    sections.push("## API Access\n");
    sections.push("You have OAuth tokens available as environment variables. Use them with curl via Bash.\n");

    for (const [key, _] of tokenEntries) {
      const svcName = key.replace("TOKEN_", "").toLowerCase();
      sections.push(`- **${svcName}**: \`$${key}\``);

      if (svcName === "gmail") {
        sections.push(`  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20"\``);
        sections.push(`  Get message: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full"\``);
      } else if (svcName === "clickup") {
        sections.push(`  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://api.clickup.com/api/v2/team"\``);
        sections.push(`  Create task: \`curl -s -X POST -H "Authorization: Bearer $${key}" -H "Content-Type: application/json" -d '{"name":"...","description":"..."}' "https://api.clickup.com/api/v2/list/{list_id}/task"\``);
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
  sections.push("When you have completed the task, output your final result as a JSON object inside a ```json code block.");
  sections.push("The JSON must contain at minimum a `summary` field (string).");
  sections.push("If you need to update persistent state for the next run, include a `state` object.");
  sections.push("Example:");
  sections.push("```json");
  sections.push(JSON.stringify({ summary: "Processed 5 emails, created 3 tickets", tickets_created: [], state: { last_run: "2025-01-01T00:00:00Z" } }, null, 2));
  sections.push("```\n");

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

export class ClaudeCodeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeTimeoutError";
  }
}
