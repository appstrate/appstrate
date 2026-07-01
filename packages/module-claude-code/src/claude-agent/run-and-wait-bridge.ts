// SPDX-License-Identifier: Apache-2.0

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  launchRunAndWait,
  waitForRunAndWaitCompletion,
  type RunAndWaitClientOptions,
  type RunAndWaitFailureResult,
  type RunAndWaitLaunchResult,
} from "@appstrate/core/run-and-wait-client";
import type { UIMessageChunk } from "ai";
import { z } from "zod";

export const RUN_AND_WAIT_MCP_SERVER_NAME = "appstrate_chat";
export const RUN_AND_WAIT_MCP_TOOL_NAME = "run_and_wait";
export const RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME = `mcp__${RUN_AND_WAIT_MCP_SERVER_NAME}__${RUN_AND_WAIT_MCP_TOOL_NAME}`;

type RunAndWaitLaunchOutcome = RunAndWaitLaunchResult | RunAndWaitFailureResult;
type WriteChunk = (chunk: UIMessageChunk) => void;

interface McpTextResult extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface PendingLaunch {
  launchPromise: Promise<RunAndWaitLaunchOutcome>;
}

export interface RunAndWaitBridgeOptions {
  origin: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal?: AbortSignal;
  write: WriteChunk;
}

const runAndWaitInputSchema = {
  kind: z.enum(["agent", "inline"]),
  scope: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
  prompt: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
};

function callToolResult(payload: unknown, isError = false): McpTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function sortForKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForKey);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortForKey((value as Record<string, unknown>)[key]);
  }
  return out;
}

function inputKey(value: unknown): string {
  return JSON.stringify(sortForKey(value));
}

export class RunAndWaitBridge {
  private readonly pendingByInput = new Map<string, PendingLaunch[]>();
  readonly mcpServer = createSdkMcpServer({
    name: RUN_AND_WAIT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "Use run_and_wait to launch Appstrate runs. It streams live progress in the chat UI and returns only when the run is complete or the wait budget expires. Do not call getRun after run_and_wait.",
    alwaysLoad: true,
    tools: [
      tool(
        RUN_AND_WAIT_MCP_TOOL_NAME,
        "Launch an Appstrate agent or inline run, stream run progress in chat, and wait for the final run status before returning.",
        runAndWaitInputSchema,
        async (args) => this.execute(args),
        {
          alwaysLoad: true,
          annotations: {
            title: "Run and wait",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
      ),
    ],
  });

  constructor(private readonly opts: RunAndWaitBridgeOptions) {}

  handleChunk(chunk: UIMessageChunk): void {
    if (chunk.type !== "tool-input-available") return;
    if (chunk.toolName !== RUN_AND_WAIT_MCP_TOOL_NAME) return;

    const pending = this.createPending(chunk.input, true);
    pending.launchPromise
      .then((result) => {
        if (!result.ok) return;
        this.opts.write({
          type: "tool-output-available",
          toolCallId: chunk.toolCallId,
          output: callToolResult(result.launch.preliminary),
        });
      })
      .catch(() => {
        // The SDK tool handler reports the same failure through the final tool result.
      });
  }

  async execute(rawArgs: unknown): Promise<McpTextResult> {
    const pending = this.claimPending(rawArgs) ?? this.createPending(rawArgs, false);
    const launched = await pending.launchPromise;
    if (!launched.ok) return callToolResult(launched.step.payload, launched.step.isError);

    const final = await waitForRunAndWaitCompletion(launched.launch, this.clientOptions());
    return callToolResult(final.payload, final.isError);
  }

  private clientOptions(): RunAndWaitClientOptions {
    return {
      origin: this.opts.origin,
      headers: this.opts.headers,
      fetch: this.opts.fetch,
      signal: this.opts.signal,
    };
  }

  private createPending(rawArgs: unknown, enqueue: boolean): PendingLaunch {
    const key = inputKey(rawArgs);
    const pending: PendingLaunch = {
      launchPromise: launchRunAndWait(rawArgs, this.clientOptions()),
    };
    if (enqueue) {
      const queue = this.pendingByInput.get(key);
      if (queue) queue.push(pending);
      else this.pendingByInput.set(key, [pending]);
    }
    return pending;
  }

  private claimPending(rawArgs: unknown): PendingLaunch | undefined {
    const key = inputKey(rawArgs);
    const queue = this.pendingByInput.get(key);
    const pending = queue?.shift();
    if (queue && queue.length === 0) this.pendingByInput.delete(key);
    return pending;
  }
}

export function createRunAndWaitBridge(opts: RunAndWaitBridgeOptions): RunAndWaitBridge {
  return new RunAndWaitBridge(opts);
}
