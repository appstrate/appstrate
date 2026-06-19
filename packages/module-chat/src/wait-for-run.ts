// SPDX-License-Identifier: Apache-2.0

/**
 * `wait_for_run` — server-side tool that blocks until an Appstrate run
 * reaches a terminal state. Ported from the appstrate-chat satellite.
 *
 * Without it the model polls `getRun` itself: each poll burns a step (the
 * turn dies at MAX_STEPS) and tokens, and slow runs end the turn with no
 * answer. Here the polling loop runs in server code inside one tool call —
 * the stream stays open, the model consumes a single step, and it resumes
 * generating the moment the run completes.
 *
 * Status goes through the same authenticated MCP session as the model's own
 * calls (`invoke_operation getRun`), so RBAC stays intact.
 */

import { tool, type ToolSet, type ToolCallOptions } from "ai";
import { z } from "zod";
import { logger } from "./logger.ts";
import {
  TERMINAL_RUN_STATUSES,
  WAIT_FOR_RUN_DEFAULT_TIMEOUT_S,
  WAIT_FOR_RUN_DESCRIPTION,
  WAIT_FOR_RUN_TIMEOUT_HINT,
  waitForRunInputShape,
} from "./run-wait-spec.ts";

const POLL_INTERVAL_MS = 3_000;

const inputSchema = z.object(waitForRunInputShape);

/** Abort-aware sleep; resolves early (without throwing) when the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Unwrap an MCP CallToolResult (`{content: [{type:"text", text}]}`) into the JSON it carries. */
function parseMcpJson(result: unknown): { status?: number; body?: unknown } {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as { status?: number; body?: unknown };
  } catch {
    return {};
  }
}

/**
 * Build the tool against an already-open MCP ToolSet (it drives
 * `invoke_operation` programmatically — the exact call the model would have
 * made by hand).
 */
export function createWaitForRunTool(mcpTools: ToolSet) {
  const invoke = mcpTools["invoke_operation"];

  return tool({
    description: WAIT_FOR_RUN_DESCRIPTION,
    inputSchema,
    execute: async ({ run_id, timeout_seconds }, options: ToolCallOptions) => {
      if (!invoke?.execute)
        return { error: "invoke_operation tool unavailable on this MCP session" };

      const timeoutMs = (timeout_seconds ?? WAIT_FOR_RUN_DEFAULT_TIMEOUT_S) * 1000;
      const start = Date.now();
      let lastBody: unknown;

      while (true) {
        if (options.abortSignal?.aborted) return { run_id, aborted: true };

        const raw = await invoke.execute(
          { operation_id: "getRun", path_params: { id: run_id } },
          { ...options, toolCallId: `${options.toolCallId}:poll` },
        );
        const { status: httpStatus, body } = parseMcpJson(raw);

        if (httpStatus !== undefined && httpStatus >= 400) {
          // 404 / 403 will never converge — surface the platform's answer as-is.
          return { run_id, error: `getRun returned HTTP ${httpStatus}`, detail: body };
        }

        const run = body as { status?: string; result?: unknown; error?: unknown } | undefined;
        lastBody = run;
        if (run?.status && TERMINAL_RUN_STATUSES.has(run.status)) {
          logger.info("wait_for_run done", {
            runId: run_id,
            status: run.status,
            waitedMs: Date.now() - start,
          });
          return {
            run_id,
            status: run.status,
            result: run.result ?? null,
            error: run.error ?? null,
            waited_seconds: Math.round((Date.now() - start) / 1000),
          };
        }

        if (Date.now() - start + POLL_INTERVAL_MS > timeoutMs) {
          logger.info("wait_for_run timed out", { runId: run_id, waitedMs: Date.now() - start });
          return {
            run_id,
            timed_out: true,
            status: run?.status ?? "unknown",
            waited_seconds: Math.round((Date.now() - start) / 1000),
            hint: WAIT_FOR_RUN_TIMEOUT_HINT,
            last_seen: lastBody ?? null,
          };
        }

        await sleep(POLL_INTERVAL_MS, options.abortSignal);
      }
    },
  });
}
