// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone stdio MCP server exposing the chat's two non-platform tools to the
 * **codex** CLI engine — the parity counterpart of the Claude engine's
 * in-process `appstrate_local` SDK server (claude-agent/local-tools.ts).
 *
 * Codex is a separate Rust binary, so it cannot host an in-process SDK MCP
 * server the way the Claude Agent SDK does. Instead the codex engine writes a
 * `[mcp_servers.appstrate_local]` stdio entry into `CODEX_HOME/config.toml`
 * pointing at this script (run by the host's `bun`); codex spawns it and speaks
 * MCP over stdio. The platform meta-tools reach codex through the separate
 * streamable-HTTP `platform` server; these two are local for the same reasons
 * as in the Claude engine:
 *   - `render_html` is a pure CLIENT-rendered artifact — the handler only acks;
 *     the HTML lives in the tool-call arguments and the browser renders it
 *     sandboxed (the codex UI-stream mapper surfaces the `mcp_tool_call` so the
 *     same React tool UI renders it).
 *   - `wait_for_run` blocks server-side on the platform's `GET /api/runs/:id?wait=`
 *     long-poll (with the caller's forwarded credentials) instead of letting the
 *     model burn turns polling.
 *
 * Inputs arrive via env (set in the config.toml `env` table by the engine):
 *   - `APPSTRATE_ORIGIN`       — loopback origin of the platform.
 *   - `APPSTRATE_MCP_HEADERS`  — JSON object of the caller's forwarded auth +
 *                                scoping headers (cookie/bearer + org/app).
 *
 * IMPORTANT: stdout is the MCP transport. This script must NEVER write anything
 * to stdout except the protocol — no `console.log`, no platform logger (which
 * emits JSON to stdout). Diagnostics, if any, go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RENDER_HTML_DESCRIPTION, renderHtmlInputShape } from "../render-html-spec.ts";
import {
  TERMINAL_RUN_STATUSES,
  WAIT_FOR_RUN_DEFAULT_TIMEOUT_S,
  WAIT_FOR_RUN_DESCRIPTION,
  WAIT_FOR_RUN_TIMEOUT_HINT,
  waitForRunInputShape,
} from "../run-wait-spec.ts";

/** Platform long-poll cap (see getRun OpenAPI: held below proxy idle timeouts). */
const LONG_POLL_CAP_S = 55;
/** Floor between polls (mirrors claude-agent/local-tools.ts — degrade-to-immediate guard). */
const POLL_FLOOR_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

interface RunStatusBody {
  status?: string;
  result?: unknown;
  error?: unknown;
}

/** Parse the forwarded-headers env (JSON object) into a header map; `{}` on absence/garbage. */
function readHeaders(): Record<string, string> {
  const raw = process.env.APPSTRATE_MCP_HEADERS;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    // malformed — fall through to empty (wait_for_run will surface an auth error)
  }
  return {};
}

const origin = process.env.APPSTRATE_ORIGIN ?? "";
const headers = readHeaders();

const server = new McpServer({ name: "appstrate_local", version: "0.1.0" });

// render_html — pure client-render: the HTML is in the call arguments; this
// only acks so the model keeps streaming.
server.registerTool(
  "render_html",
  { description: RENDER_HTML_DESCRIPTION, inputSchema: renderHtmlInputShape },
  async () => textResult({ rendered: true }),
);

// wait_for_run — blocks on the platform long-poll until the run is terminal.
server.registerTool(
  "wait_for_run",
  { description: WAIT_FOR_RUN_DESCRIPTION, inputSchema: waitForRunInputShape },
  async ({ run_id, timeout_seconds }) => {
    if (!origin) return textResult({ run_id, error: "platform origin unavailable" });
    const deadline = Date.now() + (timeout_seconds ?? WAIT_FOR_RUN_DEFAULT_TIMEOUT_S) * 1000;
    const start = Date.now();
    let last: RunStatusBody | undefined;

    while (Date.now() < deadline) {
      const remainingS = Math.ceil((deadline - Date.now()) / 1000);
      const waitS = Math.max(1, Math.min(LONG_POLL_CAP_S, remainingS));
      const before = Date.now();
      let res: Response;
      try {
        res = await fetch(`${origin}/api/runs/${encodeURIComponent(run_id)}?wait=${waitS}`, {
          headers,
        });
      } catch (err) {
        return textResult({ run_id, error: `getRun request failed: ${String(err)}` });
      }
      if (!res.ok) {
        // 404 / 403 never converge — surface verbatim.
        return textResult({ run_id, error: `getRun returned HTTP ${res.status}` });
      }
      last = (await res.json().catch(() => undefined)) as RunStatusBody | undefined;
      if (last?.status && TERMINAL_RUN_STATUSES.has(last.status)) {
        return textResult({
          run_id,
          status: last.status,
          result: last.result ?? null,
          error: last.error ?? null,
          waited_seconds: Math.round((Date.now() - start) / 1000),
        });
      }
      // Degrade-to-immediate guard: floor-sleep when the server returned far
      // sooner than the requested wait (concurrent-wait cap → `wait` ignored).
      const slept = Date.now() - before;
      const floor = Math.min(POLL_FLOOR_MS - slept, deadline - Date.now());
      if (floor > 0) await sleep(floor);
    }

    return textResult({
      run_id,
      timed_out: true,
      status: last?.status ?? "unknown",
      waited_seconds: Math.round((Date.now() - start) / 1000),
      hint: WAIT_FOR_RUN_TIMEOUT_HINT,
    });
  },
);

await server.connect(new StdioServerTransport());
