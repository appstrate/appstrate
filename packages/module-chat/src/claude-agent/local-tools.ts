// SPDX-License-Identifier: Apache-2.0

/**
 * In-process SDK MCP server exposing the chat's two non-platform tools to the
 * Claude Agent SDK engine — the parity counterpart of the `ai-sdk` path's
 * `render_html` + `wait_for_run` (chat-stream.ts / wait-for-run.ts).
 *
 * The platform's REST surface reaches the model through the HTTP MCP server
 * (`mcp__platform__*`); these two are local because:
 *   - `render_html` is a pure CLIENT-rendered artifact — the handler is a
 *     no-op ack; the HTML lives in the tool-call input and the browser renders
 *     it sandboxed (the tool name is normalized back to `render_html` by the
 *     UI-stream mapper so the same React tool UI renders it).
 *   - `wait_for_run` blocks server-side until a run is terminal instead of
 *     letting the model burn turns polling. It rides the platform's own
 *     `GET /api/runs/:id?wait=` long-poll with the caller's forwarded
 *     credentials, so RBAC is identical to a direct REST call.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logger } from "../logger.ts";

/** Mirrors `terminalRunStatusValues` in packages/db/src/schema/enums.ts. */
const TERMINAL_STATUSES = new Set(["success", "failed", "timeout", "cancelled"]);

const DEFAULT_WAIT_TIMEOUT_S = 180;
const MAX_WAIT_TIMEOUT_S = 600;
/** Platform long-poll cap (see getRun OpenAPI: held below proxy idle timeouts). */
const LONG_POLL_CAP_S = 55;

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

interface RunStatusBody {
  status?: string;
  result?: unknown;
  error?: unknown;
}

export interface LocalToolsContext {
  /** Loopback origin of the running platform (e.g. http://127.0.0.1:3000). */
  origin: string;
  /** Caller's forwarded auth + scoping headers (cookie/bearer + org/app). */
  headers: Record<string, string>;
}

/**
 * Build the `appstrate_local` in-process MCP server. One per chat turn (the
 * forwarded headers are request-scoped).
 */
export function createLocalToolsServer(ctx: LocalToolsContext) {
  const renderHtml = tool(
    "render_html",
    "Render a complete, self-contained HTML document as a live artifact shown inline to the user. " +
      "Inline CSS/JS allowed; no external network. Use for visualizations, diagrams, mockups, or small demos.",
    {
      code: z.string().describe("The complete, self-contained HTML document to render."),
      title: z.string().optional().describe("Short title for the artifact."),
    },
    // Pure client-render: the HTML is in the call input; this only acks so the
    // model keeps streaming.
    async () => textResult({ rendered: true }),
  );

  const waitForRun = tool(
    "wait_for_run",
    "Wait until an Appstrate run finishes and return its final status and result. " +
      "Always call this right after triggering a run (runInline, runAgent, …) instead of polling getRun yourself. " +
      "If it times out the run is still going: tell the user and offer to keep waiting (call it again with the same run_id).",
    {
      run_id: z.string().describe("The run id returned when the run was triggered (e.g. run_…)."),
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .max(MAX_WAIT_TIMEOUT_S)
        .optional()
        .describe(
          `How long to wait before giving up (default ${DEFAULT_WAIT_TIMEOUT_S}s, max ${MAX_WAIT_TIMEOUT_S}s).`,
        ),
    },
    async ({ run_id, timeout_seconds }) => {
      const deadline = Date.now() + (timeout_seconds ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
      const start = Date.now();
      let last: RunStatusBody | undefined;

      while (Date.now() < deadline) {
        const remainingS = Math.ceil((deadline - Date.now()) / 1000);
        const waitS = Math.max(1, Math.min(LONG_POLL_CAP_S, remainingS));
        let res: Response;
        try {
          res = await fetch(`${ctx.origin}/api/runs/${encodeURIComponent(run_id)}?wait=${waitS}`, {
            headers: ctx.headers,
          });
        } catch (err) {
          logger.warn("wait_for_run fetch failed", { runId: run_id, err: String(err) });
          return textResult({ run_id, error: `getRun request failed: ${String(err)}` });
        }
        if (!res.ok) {
          // 404 / 403 never converge — surface verbatim.
          return textResult({ run_id, error: `getRun returned HTTP ${res.status}` });
        }
        last = (await res.json().catch(() => undefined)) as RunStatusBody | undefined;
        if (last?.status && TERMINAL_STATUSES.has(last.status)) {
          logger.info("wait_for_run done", {
            runId: run_id,
            status: last.status,
            waitedMs: Date.now() - start,
          });
          return textResult({
            run_id,
            status: last.status,
            result: last.result ?? null,
            error: last.error ?? null,
            waited_seconds: Math.round((Date.now() - start) / 1000),
          });
        }
      }

      logger.info("wait_for_run timed out", { runId: run_id, waitedMs: Date.now() - start });
      return textResult({
        run_id,
        timed_out: true,
        status: last?.status ?? "unknown",
        waited_seconds: Math.round((Date.now() - start) / 1000),
        hint: "Run still in progress. Call wait_for_run again with the same run_id to keep waiting, or report the run_id to the user.",
      });
    },
  );

  return createSdkMcpServer({
    name: "appstrate_local",
    version: "0.1.0",
    tools: [renderHtml, waitForRun],
  });
}
