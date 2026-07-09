// SPDX-License-Identifier: Apache-2.0

/**
 * Client to the platform's own MCP server (`/api/mcp`, Streamable HTTP) —
 * ported from the appstrate-chat satellite (lib/appstrate-mcp.ts).
 *
 * The platform exposes its REST surface through progressive MCP tools
 * (`search_operations` / `describe_operation` / `invoke_operation`) plus the
 * run-specific `run_and_wait` shortcut. We hand them to `streamText` so the
 * model can drive Appstrate — list agents, inspect runs, search documents,
 * schedule — with the caller's own permissions. `run_and_wait` is wrapped
 * locally after discovery so it can emit an AI SDK preliminary result as soon as
 * the run id exists; that is what lets the chat render live logs while the final
 * tool result is still blocked on completion. The wrapper still uses the public
 * REST routes with the caller's forwarded auth/RBAC context.
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { runAndWaitSteps } from "@appstrate/core/run-and-wait-client";
import { logger } from "./logger.ts";

type ToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

export interface McpHandle {
  /** AI SDK ToolSet, ready for `streamText({ tools })`. */
  tools: ToolSet;
  /** Server-provided usage guidance, to append to the system prompt. */
  instructions?: string;
  /** Idempotent — safe to call from multiple stream lifecycle hooks. */
  close: () => Promise<void>;
}

/**
 * URL of the platform's org-scoped MCP endpoint, tagged `?context=injected`.
 *
 * The chat injects the get_me payload (`/api/me/context`) straight into its own
 * system prompt, so the server's get_me tool would only re-fetch what the model
 * already has. The tag tells the server to drop that redundant tool (and its
 * "call get_me first" instruction). Both chat engines build their MCP URL
 * through this helper — the ai-sdk client here and the subscription binary's
 * own connection (chat-stream.ts) — so the two never drift.
 */
export function platformMcpUrl(origin: string, orgId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}?context=injected`;
}

export async function openPlatformMcp(args: {
  origin: string;
  headers: Record<string, string>;
  /** The MCP endpoint is org-scoped: `/api/mcp/o/:org` (OAuth audience binding). */
  orgId: string;
  /** App context for app-scoped operations (agents, runs); forwarded to dispatch. */
  applicationId?: string;
  fetch?: typeof fetch;
}): Promise<McpHandle> {
  const headers: Record<string, string> = { ...args.headers };
  if (args.applicationId) headers["x-application-id"] = args.applicationId;

  const client = await createMCPClient({
    transport: {
      type: "http",
      url: platformMcpUrl(args.origin, args.orgId),
      headers,
    },
    onUncaughtError: (err) => logger.error("MCP uncaught error", { err: String(err) }),
  });

  // `createMCPClient` has already opened the session; if listing tools fails
  // we must close it or the connection leaks (the caller never gets a handle).
  let tools: ToolSet;
  try {
    tools = await client.tools();
    tools = wrapRunAndWaitTool(tools, {
      origin: args.origin,
      headers,
      fetch: args.fetch ?? fetch,
    });
    tools = wrapToolModelOutputs(tools);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch (err) {
      logger.warn("MCP client close failed", { err: String(err) });
    }
  };

  return { tools, instructions: client.instructions, close };
}

function callToolResult(payload: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function wrapRunAndWaitTool(
  tools: ToolSet,
  opts: { origin: string; headers: Record<string, string>; fetch: typeof fetch },
): ToolSet {
  const runAndWait = tools.run_and_wait as
    | (Record<string, unknown> & {
        execute?: (args: unknown, options: { abortSignal?: AbortSignal }) => unknown;
      })
    | undefined;
  if (!runAndWait?.execute) return tools;

  const wrapped = {
    ...runAndWait,
    async *execute(rawArgs: unknown, options: { abortSignal?: AbortSignal }) {
      for await (const step of runAndWaitSteps(rawArgs, {
        origin: opts.origin,
        headers: opts.headers,
        fetch: opts.fetch,
        signal: options.abortSignal,
      })) {
        yield callToolResult(step.payload, step.isError);
      }
    },
  };

  const next = { ...tools } as Record<string, unknown>;
  next.run_and_wait = wrapped;
  return next as unknown as ToolSet;
}

/**
 * Placeholder that replaces a connect/authorize URL in the MODEL-visible tool
 * output. The model can't paste a link it never receives; the UI still gets the
 * full `execute` result (untouched) and renders the native connect card from it.
 */
const REDACTED_CONNECT_LINK = "[connect link hidden — the chat renders the connect card]";

/** Field names carrying a connect/authorize URL (snake + camel). */
const CONNECT_URL_KEYS = new Set(["connect_url", "auth_url", "connectUrl", "authUrl"]);

/** Depth bound for the redaction walk — MCP payloads are shallow. */
const MAX_REDACT_DEPTH = 16;

/**
 * Deep-walk `value`, replacing any `connect_url`/`auth_url`/`connectUrl`/`authUrl`
 * string with the placeholder. Returns the (possibly new) value plus whether
 * anything changed — when nothing changed the original reference is returned so
 * callers can keep text byte-identical (prompt caching).
 */
function redactValue(value: unknown, depth: number): { value: unknown; changed: boolean } {
  if (depth > MAX_REDACT_DEPTH || value == null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = redactValue(item, depth + 1);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }

  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (CONNECT_URL_KEYS.has(key) && typeof v === "string") {
      out[key] = REDACTED_CONNECT_LINK;
      changed = true;
      continue;
    }
    const r = redactValue(v, depth + 1);
    if (r.changed) changed = true;
    out[key] = r.value;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

/**
 * Deep-redact connect links from an arbitrary payload object. Returns the same
 * reference when nothing changed (prompt-cache friendly). Used by the Pi chat
 * engine's tool forwarder ({@link ../pi-chat/mcp-tools.ts}) to scrub the
 * MODEL-visible text channel — the same guarantee `wrapToolModelOutputs` gives
 * the ai-sdk path.
 */
export function redactConnectPayload(payload: unknown): unknown {
  return redactValue(payload, 0).value;
}

/**
 * Redact connect links from a `toModelOutput` result ({type:"json"|"content"}).
 * Pure. For `content` text parts we only touch valid JSON (re-stringified only
 * when something changed) — non-JSON text is passed through untouched. Anything
 * else is returned as-is.
 */
export function redactConnectLinks(output: unknown): unknown {
  if (output == null || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;

  if (o.type === "json") {
    const r = redactValue(o.value, 0);
    return r.changed ? { ...o, value: r.value } : output;
  }

  if (o.type === "content" && Array.isArray(o.value)) {
    let changed = false;
    const nextValue = o.value.map((part) => {
      if (part == null || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;
      if (p.type !== "text" || typeof p.text !== "string") return part;
      let parsed: unknown;
      try {
        parsed = JSON.parse(p.text);
      } catch {
        return part; // Non-JSON text: leave byte-identical, never regex-mangle.
      }
      const r = redactValue(parsed, 0);
      if (!r.changed) return part;
      changed = true;
      return { ...p, text: JSON.stringify(r.value) };
    });
    return changed ? { ...o, value: nextValue } : output;
  }

  return output;
}

/**
 * Wrap every tool's `toModelOutput` so the MODEL-visible channel has connect
 * links redacted. `execute` results (what the UI renders) are untouched. Tools
 * without a `toModelOutput` are left as-is; tool object identity is otherwise
 * preserved via spread.
 */
export function wrapToolModelOutputs(tools: ToolSet): ToolSet {
  const next = { ...tools } as Record<string, unknown>;
  for (const [name, tool] of Object.entries(next)) {
    const t = tool as
      | (Record<string, unknown> & {
          toModelOutput?: (args: { output: unknown }) => unknown;
        })
      | undefined;
    if (typeof t?.toModelOutput !== "function") continue;
    const original = t.toModelOutput.bind(t);
    next[name] = {
      ...t,
      toModelOutput: (args: { output: unknown }) => redactConnectLinks(original(args)),
    };
  }
  return next as unknown as ToolSet;
}
