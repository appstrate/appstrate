// SPDX-License-Identifier: Apache-2.0

/**
 * Build the Pi extension factories that expose the platform's own MCP tools
 * (`search_operations` / `describe_operation` / `invoke_operation` +
 * `run_and_wait`) to the in-process Pi chat session — the same meta-tools the
 * `ai-sdk` chat path gets, so the assistant pilots the platform with the
 * caller's own permissions.
 *
 * Unlike the runtime container (which forwards a FIXED descriptor set), the chat
 * discovers the server's tools dynamically via `listTools()` and registers one
 * forwarding Pi tool per advertised tool. `run_and_wait` gets a bespoke
 * extension that streams a LIVE preliminary run card into the UI stream (the
 * run id appears the moment the run is launched, then the card updates as the
 * run progresses) while the tool result stays blocked on completion — the same
 * behaviour the `ai-sdk` path gets from `wrapRunAndWaitTool`.
 */

import { runAndWaitSteps } from "@appstrate/core/run-and-wait-client";
import { createMcpHttpClient, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { Type, type ExtensionAPI, type ExtensionFactory } from "@appstrate/runner-pi";
import type { UIMessageChunk } from "ai";
import { stripMcpToolPrefix } from "./ui-stream-mapper.ts";
import {
  redactConnectPayload,
  splitConnectPayload,
  splitJsonText,
  type ConnectOffer,
} from "../connect-offer.ts";
import { logger } from "../logger.ts";

const RUN_AND_WAIT_TOOL = "run_and_wait";

/** Pi `AgentToolResult`-shaped payload (text content + structured details). */
interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  /** Typed connect offer for the UI card; pi-ai never serializes it upstream. */
  connectOffer?: ConnectOffer;
}

/**
 * Wrap an arbitrary payload as a Pi tool result. Channel split mirrors the
 * ai-sdk path's `wrapToolConnectOffers`: `content` is what pi-ai serializes to
 * the MODEL, so connect links are redacted there; the connect URL surfaces
 * ONLY through the typed `connectOffer` field the connect card reads. `details`
 * (UI JSON view) carries the redacted payload — the live URL lives in exactly
 * one place.
 */
export function toPiToolResult(payload: unknown): PiToolResult {
  const { redacted, offer } = splitConnectPayload(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(redacted) }],
    details: redacted,
    ...(offer ? { connectOffer: offer } : {}),
  };
}

/** Adapt an MCP `CallToolResult` to Pi's `AgentToolResult` (text/image blocks only). */
export function mcpResultToPi(result: {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
}): PiToolResult {
  let offer: ConnectOffer | null = null;
  const content = result.content.map((c) => {
    // MODEL-visible channel — scrub connect links from JSON text (valid JSON is
    // redacted and re-stringified only when something changed; non-JSON text
    // passes through byte-identical). The scrubbed URL is captured as the
    // typed offer instead.
    if (c.type === "text") {
      const split = splitJsonText(String(c.text ?? ""));
      offer ??= split.offer;
      return { type: "text" as const, text: split.text };
    }
    // Pi tool results the LLM reads are text/image; render anything else as a
    // text pointer so the model still sees it (parity with the runtime forwarder).
    if (c.type === "image") {
      return { type: "text" as const, text: `[image ${String(c.mimeType ?? "")}]` };
    }
    return { type: "text" as const, text: JSON.stringify(redactConnectPayload(c)) };
  });
  // `details` is UI-only (never serialized to the model) but persisted — so it
  // is redacted too; the connect card reads the typed `connectOffer` field.
  let details: unknown;
  if (result.structuredContent !== undefined) {
    const sc = splitConnectPayload(result.structuredContent);
    // structuredContent is the canonical payload — its offer wins.
    if (sc.offer) offer = sc.offer;
    details = sc.redacted;
  } else {
    details = { ...result, content };
  }
  return { content, details, ...(offer ? { connectOffer: offer } : {}) };
}

export interface PlatformMcpTools {
  extensionFactories: ExtensionFactory[];
  /** Server usage guidance (MCP `instructions`), to append to the system prompt. */
  instructions?: string;
  /** Idempotent teardown of the MCP client. */
  close(): Promise<void>;
}

export interface BuildPlatformMcpToolsOptions {
  /** Platform MCP endpoint (`/api/mcp/o/:org?context=injected`). */
  url: string;
  /** Auth + scoping headers (short-lived MCP loopback bearer + org/app ids). */
  headers: Record<string, string>;
  /** Emits a UI chunk into the live turn stream (used for run_and_wait cards). */
  writeChunk: (chunk: UIMessageChunk) => void;
  /** Cancellation for tool calls + the run_and_wait poll loop. */
  signal: AbortSignal;
}

/**
 * Open the platform MCP client, discover its tools, and build one Pi extension
 * factory per tool. Caller owns the returned `close()` (call it in the turn's
 * finally). Throws if the MCP handshake or tool listing fails — the chat's whole
 * value is the meta-tools, so a failure here is a genuine misconfiguration, not
 * a silently-degraded no-tools chat.
 */
export async function buildPlatformMcpTools(
  opts: BuildPlatformMcpToolsOptions,
): Promise<PlatformMcpTools> {
  const client = await createMcpHttpClient(opts.url, {
    clientInfo: { name: "appstrate-chat-pi", version: "1.0" },
    extraHeaders: opts.headers,
  });

  let listed: Awaited<ReturnType<AppstrateMcpClient["listTools"]>>;
  try {
    listed = await client.listTools({ signal: opts.signal });
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  const runOrigin = new URL(opts.url).origin;
  const extensionFactories = listed.tools.map((tool) =>
    tool.name === RUN_AND_WAIT_TOOL
      ? makeRunAndWaitExtension(tool, {
          origin: runOrigin,
          headers: opts.headers,
          writeChunk: opts.writeChunk,
          signal: opts.signal,
        })
      : makeForwardExtension(tool, client, opts.signal),
  );

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client
      .close()
      .catch((err) => logger.warn("chat pi mcp close failed", { err: String(err) }));
  };

  const instructions = client.client.getInstructions();
  return {
    extensionFactories,
    ...(instructions ? { instructions } : {}),
    close,
  };
}

/** Generic forwarding Pi tool: verbatim `tools/call` → adapted Pi result. */
function makeForwardExtension(
  tool: { name: string; description?: string; inputSchema: unknown },
  client: AppstrateMcpClient,
  signal: AbortSignal,
): ExtensionFactory {
  const toolName = stripMcpToolPrefix(tool.name);
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description ?? toolName,
      parameters: Type.Unsafe<Record<string, unknown>>(
        (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
      ),
      async execute(_toolCallId: string, params: unknown, execSignal?: AbortSignal) {
        const result = await client.callTool(
          { name: tool.name, arguments: (params as Record<string, unknown>) ?? {} },
          { signal: execSignal ?? signal },
        );
        return mcpResultToPi(result as never);
      },
    });
  };
}

/**
 * `run_and_wait` Pi tool: launch a run, stream the preliminary + progress cards
 * live into the UI stream, and return the FINAL run payload as the tool result.
 * The intermediate cards and the final tool output share the tool call id, so
 * the client renders one card that updates from launch → running → terminal.
 */
function makeRunAndWaitExtension(
  tool: { name: string; description?: string; inputSchema: unknown },
  ctx: {
    origin: string;
    headers: Record<string, string>;
    writeChunk: (chunk: UIMessageChunk) => void;
    signal: AbortSignal;
  },
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: RUN_AND_WAIT_TOOL,
      label: RUN_AND_WAIT_TOOL,
      description: tool.description ?? "Launch an Appstrate run and wait for completion.",
      parameters: Type.Unsafe<Record<string, unknown>>(
        (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
      ),
      async execute(toolCallId: string, params: unknown, execSignal?: AbortSignal) {
        let finalPayload: Record<string, unknown> = {
          error: "run_and_wait produced no result",
        };
        for await (const step of runAndWaitSteps(params, {
          origin: ctx.origin,
          headers: ctx.headers,
          fetch,
          signal: execSignal ?? ctx.signal,
        })) {
          finalPayload = step.payload;
          // Live card: push each step's payload under this tool call id so the
          // UI reflects launch → progress → terminal before execute resolves.
          ctx.writeChunk({
            type: "tool-output-available",
            toolCallId,
            output: toPiToolResult(step.payload),
          });
        }
        // The final step is ALSO delivered as the tool result (tool_execution_end
        // re-emits it under the same id — an idempotent update to the same card).
        return toPiToolResult(finalPayload);
      },
    });
  };
}
