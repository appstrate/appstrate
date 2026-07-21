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
import { runAndWaitStepsWithDocuments } from "@appstrate/core/run-and-wait-client";
import { redactConnectLinks, splitConnectPayload, splitToolResult } from "./connect-offer.ts";
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
    tools = wrapToolConnectOffers(tools);
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
  // Split at the source: the model channel (content text) is redacted, the UI
  // gets the connect URL only through the typed `connectOffer` field.
  const { redacted, offer } = splitConnectPayload(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(redacted) }],
    ...(offer ? { connectOffer: offer } : {}),
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
      for await (const step of runAndWaitStepsWithDocuments(rawArgs, {
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
 * Wrap every tool's `execute` so its result — what the AI SDK persists and the
 * UI renders — has connect links redacted at the source, with the captured URL
 * attached as the typed `connectOffer` field the connect card reads
 * ({@link ./connect-offer.ts}). Tools without an `execute` are left as-is;
 * `run_and_wait` is replaced wholesale by {@link wrapRunAndWaitTool} afterwards
 * (its streamed steps split inside `callToolResult`).
 */
export function wrapToolConnectOffers(tools: ToolSet): ToolSet {
  const next = { ...tools } as Record<string, unknown>;
  for (const [name, tool] of Object.entries(next)) {
    const t = tool as
      | (Record<string, unknown> & {
          execute?: (args: unknown, options: unknown) => unknown;
        })
      | undefined;
    if (typeof t?.execute !== "function") continue;
    const original = t.execute.bind(t);
    next[name] = {
      ...t,
      async execute(args: unknown, options: unknown) {
        return splitToolResult(await original(args, options));
      },
    };
  }
  return next as unknown as ToolSet;
}

/**
 * Wrap every tool's `toModelOutput` so the MODEL-visible channel has connect
 * links redacted. Belt-and-braces on top of {@link wrapToolConnectOffers}
 * (execute results are already split at the source): it also covers a
 * `toModelOutput` that re-serializes the whole output — the offer's inner key
 * is `connect_url`, so the redactor scrubs it too. Tools without a
 * `toModelOutput` are left as-is; tool object identity is otherwise preserved
 * via spread.
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
