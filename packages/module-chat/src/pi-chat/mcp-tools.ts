// SPDX-License-Identifier: Apache-2.0

/**
 * Build the Pi extension factories that expose the platform's own MCP tools
 * (`search_operations` / `describe_operation` / `invoke_operation` +
 * `run_and_wait`) to the in-process Pi chat session — the same meta-tools the
 * platform MCP server exposes, so the assistant pilots the platform with the
 * caller's own permissions.
 *
 * Unlike the runtime container (which forwards a FIXED descriptor set), the chat
 * discovers the server's tools dynamically via `listTools()` and registers one
 * forwarding Pi tool per advertised tool. `run_and_wait` gets a bespoke
 * extension that streams a LIVE preliminary run card into the UI stream (the
 * run id appears the moment the run is launched, then the card updates as the
 * run progresses) while the tool result stays blocked on completion — the same
 * behaviour the live run card needs.
 */

import { formatTurnBudgetNote } from "@appstrate/core/chat-turn-metadata";
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
import { runAndWaitStepsWithinTurnBudget } from "../run-budget.ts";
import { logger } from "../logger.ts";

const RUN_AND_WAIT_TOOL = "run_and_wait";

/** Pi `AgentToolResult`-shaped payload (text content + structured details). */
interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  /**
   * Typed connect offer for the UI card; pi-ai never serializes it upstream.
   * CONTRACT: pi-agent-core preserves unknown result fields across the
   * `afterToolCall` hook — `finalizeExecutedToolCall` SPREADS the original
   * result (`{...result, content, details, usage, terminate}`, `agent-loop.js`),
   * so a configured hook can no longer strip this field. Verified against the
   * pinned `@earendil-works/pi-agent-core@0.84.2`; re-check on an SDK bump,
   * because `details` is redacted and nothing would fall back.
   */
  connectOffer?: ConnectOffer;
}

/**
 * Wrap an arbitrary payload as a Pi tool result. The channel split is the
 * point. The model-visible channel: `content` is what pi-ai serializes to
 * the MODEL, so connect links are redacted there; the connect URL surfaces
 * ONLY through the typed `connectOffer` field the connect card reads. `details`
 * (Pi's in-memory UI channel; stripped before persistence by
 * `ui-stream-mapper.ts`) carries the redacted payload — the live URL lives in
 * exactly one place.
 */
export function toPiToolResult(payload: unknown): PiToolResult {
  const { redacted, offer } = splitConnectPayload(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(redacted) }],
    details: redacted,
    ...(offer ? { connectOffer: offer } : {}),
  };
}

/** Adapt an MCP `CallToolResult` to Pi's `AgentToolResult` (every block as text). */
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
  // `details` is Pi's in-memory UI channel (never serialized to the model,
  // stripped before persistence) — redacted all the same, so the live URL
  // exists only in the typed `connectOffer` field the connect card reads.
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

interface PlatformMcpTools {
  extensionFactories: ExtensionFactory[];
  /** Server usage guidance (MCP `instructions`), to append to the system prompt. */
  instructions?: string;
  /** Idempotent teardown of the MCP client. */
  close(): Promise<void>;
}

/**
 * The hosting turn's budget, as the tool layer sees it: an absolute deadline
 * (propagated into every `run_and_wait`) plus the live model-call count (so each
 * tool result can tell the model where it stands — A5).
 */
export interface PiTurnBudget {
  /** Absolute instant this turn ends. */
  deadlineAt: number;
  /** Model calls completed so far in the turn (`PiChatUiStreamMapper.stepCount`). */
  stepCount: () => number;
  /**
   * Trace attribution, and the link stamped on every run this turn launches so
   * an orphaned run can still report back (C3). Null on an ephemeral turn.
   */
  chatSessionId?: string | null;
  /** Owning organization — scopes the orphan-run link write. */
  orgId?: string;
  /** Clock seam (tests inject a fixed now). */
  now?: () => number;
}

interface BuildPlatformMcpToolsOptions {
  /** Platform MCP endpoint (`/api/mcp/o/:org?context=injected`). */
  url: string;
  /** Auth + scoping headers (short-lived MCP loopback bearer + org/space ids). */
  headers: Record<string, string>;
  /** Emits a UI chunk into the live turn stream (used for run_and_wait cards). */
  writeChunk: (chunk: UIMessageChunk) => void;
  /** Cancellation for tool calls + the run_and_wait poll loop. */
  signal: AbortSignal;
  /** Turn deadline + step counter — bounds run_and_wait and feeds the budget note. */
  turnBudget: PiTurnBudget;
  /**
   * Transport for every platform hop the tool layer makes. Production passes the
   * platform's in-process dispatch, so the MCP handshake (`initialize` /
   * `notifications/initialized` / `tools/list`) AND each `run_and_wait`'s launch
   * POST + poll loop re-enter the Hono app directly instead of opening real
   * loopback TCP connections to this same process. `run_and_wait` is the heavier
   * half by far — the handshake is three hops per turn, a single run is one
   * launch plus a poll per ~55 s of wait. Auth and RBAC still run on every hop —
   * `dispatch` goes through the full pipeline — so this trades sockets for
   * latency, not safety.
   *
   * Omitted (tests, and any caller without a dispatcher) → global `fetch`, i.e.
   * the previous behaviour.
   */
  fetch?: typeof fetch;
}

/**
 * Append the turn-budget line to a tool result's MODEL channel (A5).
 *
 * Why the tool result and not the system prompt: the Pi system prompt is built
 * ONCE per session, and pi-ai anchors its Anthropic conversation cache breakpoint
 * on the LAST message of each request — so a per-step note appended as a trailing
 * synthetic message would move the breakpoint every step and never hit the cache
 * again. Written into a tool result the note is frozen into the transcript the
 * moment it is produced, so every later request keeps the exact same prefix and
 * the cache still hits.
 *
 * The note lands in `content`, which the UI parses too (nothing reads `details`),
 * so the payload stops being the only text part. `unwrapResult` on the UI side is
 * deliberately tolerant of trailing non-payload text — do not append here without
 * checking it still is.
 */
export function withTurnBudgetNote(result: PiToolResult, budget: PiTurnBudget): PiToolResult {
  const now = (budget.now ?? Date.now)();
  const text = formatTurnBudgetNote({
    remainingMs: budget.deadlineAt - now,
    stepsUsed: budget.stepCount(),
  });
  return { ...result, content: [...result.content, { type: "text", text }] };
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
    // The HANDSHAKE, not only the `listTools` below. In production `opts.fetch`
    // is the platform's in-process dispatch, so `initialize` re-enters the same
    // process — a DB pool exhausted by concurrent runs or a module hook that
    // never settles wedges it, and without the signal the turn's stop button
    // and its deadline are both inert for the SDK's full 60 s request timeout.
    signal: opts.signal,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
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
          // Same seam as the handshake above, and this is the tool that needs
          // it most: every `run_and_wait` is a launch POST plus a poll loop.
          fetch: opts.fetch ?? fetch,
          writeChunk: opts.writeChunk,
          signal: opts.signal,
          turnBudget: opts.turnBudget,
        })
      : makeForwardExtension(tool, client, opts.signal, opts.turnBudget),
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
  turnBudget: PiTurnBudget,
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
        return withTurnBudgetNote(mcpResultToPi(result as never), turnBudget);
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
    /** Transport for the launch POST and the poll loop — see the option above. */
    fetch: typeof fetch;
    writeChunk: (chunk: UIMessageChunk) => void;
    signal: AbortSignal;
    turnBudget: PiTurnBudget;
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
        // The run's wait budget descends from the TURN's deadline (never the
        // 30-minute client default), and a launch with no room left is refused
        // here — before any run row exists.
        for await (const step of runAndWaitStepsWithinTurnBudget(params, {
          origin: ctx.origin,
          headers: ctx.headers,
          fetch: ctx.fetch,
          signal: execSignal ?? ctx.signal,
          budget: {
            turnDeadlineAt: ctx.turnBudget.deadlineAt,
            chatSessionId: ctx.turnBudget.chatSessionId,
            ...(ctx.turnBudget.orgId ? { orgId: ctx.turnBudget.orgId } : {}),
            ...(ctx.turnBudget.now ? { now: ctx.turnBudget.now } : {}),
          },
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
        // That last write is the one the card keeps, and it carries the budget
        // note appended to `content` — the very channel the card parses.
        return withTurnBudgetNote(toPiToolResult(finalPayload), ctx.turnBudget);
      },
    });
  };
}
