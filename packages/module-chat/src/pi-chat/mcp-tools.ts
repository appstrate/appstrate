// SPDX-License-Identifier: Apache-2.0

/**
 * Build the Pi extension factories that expose the platform's own MCP tools
 * to the in-process Pi chat session — exactly the tools the platform MCP server
 * declares to the caller (`search` / `describe` / `invoke_operation`,
 * `run_and_wait`, `call_integration_tool`, and whatever it adds later), so the assistant pilots
 * the platform with the caller's own permissions, through the one door every
 * MCP client uses.
 *
 * Unlike the runtime container (which forwards a FIXED descriptor set), the chat
 * discovers the server's tools dynamically via `listTools()` and registers one
 * forwarding Pi tool per advertised tool. `run_and_wait` gets a bespoke
 * extension that streams a LIVE preliminary run card into the UI stream (the
 * run id appears the moment the run is launched, then the card updates as the
 * run progresses) while the tool result stays blocked on completion — the same
 * behaviour the live run card needs. `read_resource` reads a resource of the
 * platform server (a skill's files, by `skill://` URI) through `resources/read`.
 */

import type { InlineRunModel } from "@appstrate/core/run-and-wait-client";
import {
  ACTIVE_SPACES_META_KEY,
  defaultMcpSpaceId,
  OPERATION_SPACES_META_KEY,
  projectActiveInSpaces,
  spaceIdRefusal,
  type NamedSpace,
} from "@appstrate/core/mcp-spaces";
import { canComposeInline, canRunAgents } from "@appstrate/core/permissions";
import { assistantVisibleMcpResult } from "@appstrate/core/mcp-result";
import {
  isLookupTool,
  readToolPresentation,
  TOOL_PRESENTATION_META_KEY,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { formatTurnBudgetNote, turnBudgetNoteBlock } from "@appstrate/core/chat-turn-metadata";
import { parseSkillUri, SKILL_URI_PREFIX } from "@appstrate/core/skill-address";
import {
  createMcpHttpClient,
  RESOURCE_BLOB_MAX_BYTES,
  RESOURCE_OVERSIZED_NOTE,
  RESOURCE_TEXT_MAX_BYTES,
  isRelayedResult,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { unsafeSchema, type ExtensionAPI, type ExtensionFactory } from "@appstrate/runner-pi";
import type { UIMessageChunk } from "ai";
import { fileTypeFromBuffer } from "file-type";
import { dispatchSpace, stripMcpToolPrefix } from "./ui-stream-mapper.ts";
import {
  mergeConnectOffers,
  offerScopeOf,
  splitJsonText,
  type ConnectOffer,
  type OfferScope,
} from "../connect-offer.ts";
import { runAndWaitStepsWithinTurnBudget } from "../run-budget.ts";
import { logger } from "../logger.ts";
import { FILE_NAME_META_KEY, isFileUri } from "@appstrate/core/file-uri";
import { isRasterImageMime, normalizeMime } from "@appstrate/core/mime";
import type { FileDelivery } from "../file-input.ts";
import type { TurnPdfInput } from "./native-pdf.ts";
import { platformMcpSurfaceCache, type PlatformMcpSurface } from "./mcp-surface-cache.ts";

const RUN_AND_WAIT_TOOL = "run_and_wait";
const READ_RESOURCE_TOOL = "read_resource";

/** Pi `AgentToolResult`-shaped payload (text content + structured details). */
interface PiToolResult {
  content: Array<
    | { type: "text"; text: string; annotations?: unknown; _meta?: unknown }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: true;
  /** Local receipts replacing live file contents on SSE and in replay. */
  persistedContent?: Array<{ type: "text"; text: string; annotations?: unknown; _meta?: unknown }>;
  details: unknown;
  /**
   * Typed connect offers for the UI cards — one per connect URL the payload
   * carried, in walk order; omitted entirely when there were none, so a payload
   * without connect links stays byte-identical. pi-ai never serializes the
   * field upstream.
   * CONTRACT: pi-agent-core preserves unknown result fields across the
   * `afterToolCall` hook — `finalizeExecutedToolCall` SPREADS the original
   * result (`{...result, content, details, usage, terminate}`, `agent-loop.js`),
   * so a configured hook cannot strip this field. Verified against the
   * pinned `@earendil-works/pi-agent-core@1.0.4`; re-check on an SDK bump,
   * because `details` is redacted and nothing would fall back.
   */
  connectOffers?: ConnectOffer[];
  /** Platform-owned metadata for the UI. Remote result text never supplies destinations. */
  actedSpaceIds?: readonly string[];
  terminate?: boolean;
  /**
   * The platform marked the result relayed (`_meta["dev.appstrate/relayed"]`): a third party
   * wrote it whole, so it was passed on verbatim. Persisted beside `connectOffers` (same
   * contract), so a replay walks the stored text under the scope the live call had.
   */
  relayed?: true;
  /** The platform's `readToolPresentation`: the UI stream's metadata, never the model's. */
  presentation?: ToolPresentation;
}

/**
 * Wrap an arbitrary payload as a Pi tool result. The channel split is the
 * point. The model-visible channel: `content` is what pi-ai serializes to
 * the MODEL, so connect links are redacted there; the connect URLs surface
 * ONLY through the typed `connectOffers` field the connect cards read.
 * `details` (Pi's in-memory UI channel; stripped before persistence by
 * `ui-stream-mapper.ts`) carries the redacted payload — the live URLs live in
 * exactly one place.
 */
export function toPiToolResult(payload: unknown, scope: OfferScope): PiToolResult {
  const { redacted, offers } = scope(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(redacted) }],
    details: redacted,
    ...(offers.length > 0 ? { connectOffers: offers } : {}),
  };
}

/**
 * Adapt an MCP `CallToolResult` to Pi's `AgentToolResult` (every block as text). `scope` says
 * which part of the payload may carry a connect offer ({@link offerScopeOf}); a result the
 * platform marked relayed keeps the mark ({@link PiToolResult.relayed}).
 */
export function mcpResultToPi(
  result: {
    content: Array<Record<string, unknown>>;
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: unknown;
  },
  scope: OfferScope,
): PiToolResult {
  // One list per text block, merged below — a result may split a readiness
  // error across blocks, and each block's connect links must all reach the UI.
  const blockOffers: ConnectOffer[][] = [];
  const content = result.content.map((c) => {
    // MODEL-visible channel — scrub connect links from JSON text (valid JSON is
    // redacted and re-stringified only when something changed; non-JSON text
    // passes through byte-identical). The scrubbed URLs are captured as the
    // typed offers instead.
    if (c.type === "text") {
      const split = splitJsonText(String(c.text ?? ""), scope);
      blockOffers.push(split.offers);
      return { type: "text" as const, text: split.text };
    }
    // Pi tool results the LLM reads are text/image; render anything else as a
    // text pointer so the model still sees it (parity with the runtime forwarder).
    if (c.type === "image") {
      return { type: "text" as const, text: `[image ${String(c.mimeType ?? "")}]` };
    }
    if (
      c.type === "resource" &&
      c.resource &&
      typeof c.resource === "object" &&
      "blob" in c.resource
    ) {
      return { type: "text" as const, text: "[binary resource omitted]" };
    }
    return { type: "text" as const, text: JSON.stringify(scope(c).redacted) };
  });
  let offers = mergeConnectOffers(blockOffers);
  // `details` is Pi's in-memory UI channel (never serialized to the model,
  // stripped before persistence) — redacted all the same, so the live URLs
  // exist only in the typed `connectOffers` field the connect cards read.
  let details: unknown;
  if (result.structuredContent !== undefined) {
    const sc = scope(result.structuredContent);
    // structuredContent is the canonical payload — its offers replace the
    // text-derived ones wholesale, rather than merging with a text block that
    // may be a partial rendering of the same thing.
    if (sc.offers.length > 0) offers = sc.offers;
    details = sc.redacted;
  } else {
    details = { ...result, content };
  }
  const presentation = readToolPresentation(result._meta);
  return {
    content,
    details,
    // Pi keeps a returned `isError` with the rest of the result (`executePreparedToolCall`).
    ...(result.isError === true ? { isError: true as const } : {}),
    ...(offers.length > 0 ? { connectOffers: offers } : {}),
    ...(isRelayedResult(result) ? { relayed: true as const } : {}),
    ...(presentation && { presentation }),
  };
}

type RemoteToolResult = Awaited<ReturnType<AppstrateMcpClient["callTool"]>>;

async function liveRelayedImage(
  block: Extract<RemoteToolResult["content"][number], { type: "image" }>,
  sendsImages: boolean,
): Promise<PiToolResult["content"][number]> {
  const mimeType = normalizeMime(block.mimeType);
  if (!isRasterImageMime(mimeType)) return { type: "text", text: "Unsupported image format." };
  if (!sendsImages) return { type: "text", text: "The current model cannot read images." };
  if (Buffer.byteLength(block.data, "base64") > RESOURCE_BLOB_MAX_BYTES) {
    return { type: "text", text: RESOURCE_OVERSIZED_NOTE };
  }
  // MCP validates base64. The integration supplies the MIME type, so verify it against the bytes.
  const detected = await fileTypeFromBuffer(Buffer.from(block.data, "base64")).catch(
    () => undefined,
  );
  if (detected?.mime !== mimeType) {
    return {
      type: "text",
      text: "Invalid image data or image format does not match its declared MIME type.",
    };
  }
  return { type: "image", mimeType, data: block.data };
}

/** Only the inline image data reaches the model. A remote URI never triggers a read. */
async function relayedToolResult(
  result: RemoteToolResult,
  scope: OfferScope,
  sendsImages: boolean,
): Promise<PiToolResult> {
  const blocks = result.content;
  const projected = mcpResultToPi(result, scope);
  if (!blocks.some((block) => block.type === "image")) return projected;
  const content = [...projected.content];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "image") content[index] = await liveRelayedImage(block, sendsImages);
  }
  const persistedContent = content.map((block) =>
    block.type === "text"
      ? block
      : {
          type: "text" as const,
          text: `[image ${block.mimeType}, ${Buffer.byteLength(block.data, "base64")} bytes, read for this turn]`,
        },
  );
  return { ...projected, content, persistedContent };
}

interface PlatformMcpTools {
  extensionFactories: ExtensionFactory[];
  /** Server usage guidance (MCP `instructions`), to append to the system prompt. */
  instructions?: string;
  /** The tools whose calls only look things up (`isLookupTool`), by the name the model calls. */
  lookupTools: ReadonlySet<string>;
  surfaceCached: boolean;
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

/**
 * What a conversation's connection needs from it: the spaces a call may name (on the
 * organization endpoint, `/api/mcp/o/:org`, each space-acting tool takes a `space_id`; a
 * limited conversation's are its origin space alone), and the record of the spaces the
 * conversation touched.
 */
export interface TurnSpaces {
  /** Defaults apply only to the current turn and remain subject to its reachable spaces. */
  originSpaceId?: string;
  /** The turn's spaces, each with the caller's effective permissions there. */
  spaces: readonly (NamedSpace & { permissions: readonly string[] })[];
  /**
   * Record `spaceId` (one of `spaces`) on the session. Throws when it cannot be recorded, and
   * the call fails.
   */
  touch(spaceId: string): Promise<void>;
  /**
   * The space of the file `uri` names. A missing file names none, nor does one the conversation
   * holds: it is reached through its container, not a space.
   */
  fileSpace(uri: string): Promise<string | undefined>;
}

type BuildPlatformMcpToolsOptions = {
  /** Platform MCP endpoint (`/api/mcp/o/:org?renders_cards=true`). */
  url: string;
  /** The spaces a call may name: each space-acting call takes its `space_id`. */
  organization: TurnSpaces;
  /** Auth + org headers (short-lived MCP loopback bearer + org id). */
  headers: Record<string, string>;
  /** Emits a UI chunk into the live turn stream (used for run_and_wait cards). */
  writeChunk: (chunk: UIMessageChunk) => void;
  /** Cancellation for tool calls + the run_and_wait poll loop. */
  signal: AbortSignal;
  /** Turn deadline + step counter — bounds run_and_wait and feeds the budget note. */
  turnBudget: PiTurnBudget;
  /**
   * Transport for every platform hop the tool layer makes. Production passes the
   * platform's in-process dispatch, so the MCP handshake (`initialize` / `tools/list`,
   * no era probe: the platform's server is legacy by construction)
   * AND each `run_and_wait`'s launch
   * POST + poll loop re-enter the Hono app directly instead of opening real
   * loopback TCP connections to this same process. `run_and_wait` is the heavier
   * half by far — the handshake is at most two hops per turn, a single run is one
   * launch plus a poll per ~55 s of wait. Auth and RBAC still run on every hop —
   * `dispatch` goes through the full pipeline — so this trades sockets for
   * latency, not safety.
   *
   * Omitted (tests, and any caller without a dispatcher) → global `fetch`, i.e.
   * the previous behaviour.
   */
  fetch?: typeof fetch;
  surfaceKey?: string;
  /**
   * The model the turn's INLINE runs launch on (the composer's opt-in): handed to the
   * launch client, never declared on the tool, so the model cannot set it.
   */
  inlineRunModel?: InlineRunModel;
  fileDelivery: FileDelivery;
  pdfInput?: TurnPdfInput;
};

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
 * so the payload stops being the only text part. The block is marked
 * (`isTurnBudgetNoteBlock`); readers that want the payload alone drop it by that marker.
 */
export function withTurnBudgetNote(result: PiToolResult, budget: PiTurnBudget): PiToolResult {
  const now = (budget.now ?? Date.now)();
  const text = formatTurnBudgetNote({
    remainingMs: budget.deadlineAt - now,
    stepsUsed: budget.stepCount(),
  });
  const note = turnBudgetNoteBlock(text);
  return {
    ...result,
    content: [...result.content, note],
    // What is stored ends with the note too: readers drop the note by its marker.
    ...(result.persistedContent && { persistedContent: [...result.persistedContent, note] }),
  };
}

/**
 * The stateless MCP server answers these one way: `notifications/initialized` → 202 (its
 * transport's reply to any request-free POST; no `oninitialized`), SSE `GET` → 405.
 */
function answerStatelessHopsLocally(next: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method?.toUpperCase();
    if (method === "GET") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const body = init?.body;
    if (
      method === "POST" &&
      typeof body === "string" &&
      body.includes('"notifications/initialized"')
    ) {
      const msg = JSON.parse(body) as { id?: unknown; method?: unknown };
      if (msg.method === "notifications/initialized" && msg.id === undefined) {
        return new Response(null, { status: 202 });
      }
    }
    return next(input, init);
  }) as typeof fetch;
}

/**
 * Open the platform MCP client, discover its tools, and build one Pi extension
 * factory per tool. Caller owns the returned `close()` (call it in the turn's
 * finally). Throws if the MCP handshake or tool listing fails — the chat's whole
 * value is the meta-tools, so a failure here is a genuine misconfiguration, not
 * a silently-degraded no-tools chat. On a cache hit the client opens on the first
 * `tools/call`; a failed lazy connect fails that call and evicts the entry unless
 * the turn was stopped, so the next turn handshakes eagerly and fails loudly.
 */
/** A connected client of the platform MCP server at `opts.url`, authenticated by `opts.headers`. */
export function connectPlatformMcp(opts: {
  url: string;
  headers: Record<string, string>;
  /** Cancels the connect: `initialize` re-enters this process and can wedge. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<AppstrateMcpClient> {
  return createMcpHttpClient(opts.url, {
    clientInfo: { name: "appstrate-chat-pi", version: "1.0" },
    // The platform's MCP module is on the v1 SDK, legacy by construction: no era probe.
    era: "legacy",
    extraHeaders: opts.headers,
    ...(opts.signal ? { signal: opts.signal } : {}),
    fetch: answerStatelessHopsLocally(opts.fetch ?? fetch),
  });
}

export async function buildPlatformMcpTools(
  opts: BuildPlatformMcpToolsOptions,
): Promise<PlatformMcpTools> {
  // The turn's signal (not a tool call's — a lazy connect is shared) keeps stop and deadline live.
  const connect = () =>
    connectPlatformMcp({
      url: opts.url,
      headers: opts.headers,
      signal: opts.signal,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });

  const { surfaceKey } = opts;
  const cached = surfaceKey === undefined ? undefined : platformMcpSurfaceCache.get(surfaceKey);
  let surface: PlatformMcpSurface;
  let client: Promise<AppstrateMcpClient> | undefined;
  if (cached) {
    surface = cached;
  } else {
    const opened = await connect();
    try {
      const listed = await opened.listTools({ signal: opts.signal });
      surface = { tools: listed.tools, instructions: opened.getInstructions() };
    } catch (err) {
      await opened.close().catch(() => {});
      throw err;
    }
    client = Promise.resolve(opened);
    if (surfaceKey !== undefined) platformMcpSurfaceCache.set(surfaceKey, surface);
  }

  let closed = false;
  const getClient = (): Promise<AppstrateMcpClient> => {
    if (closed) return Promise.reject(new Error("platform MCP client already closed"));
    client ??= connect().catch((err: unknown) => {
      client = undefined;
      if (surfaceKey !== undefined && !opts.signal.aborted) {
        platformMcpSurfaceCache.delete(surfaceKey);
      }
      throw err;
    });
    return client;
  };

  const runOrigin = new URL(opts.url).origin;
  const { organization } = opts;
  const toolFactories = surface.tools.map((tool) =>
    tool.name === RUN_AND_WAIT_TOOL
      ? makeRunAndWaitExtension(tool, {
          origin: runOrigin,
          headers: opts.headers,
          organization,
          // Same seam as the handshake above, and this is the tool that needs
          // it most: every `run_and_wait` is a launch POST plus a poll loop.
          fetch: opts.fetch ?? fetch,
          writeChunk: opts.writeChunk,
          signal: opts.signal,
          turnBudget: opts.turnBudget,
          ...(opts.inlineRunModel ? { inlineRunModel: opts.inlineRunModel } : {}),
        })
      : makeForwardExtension(tool, getClient, opts),
  );
  const extensionFactories = [...toolFactories, makeReadResourceExtension(getClient, opts)];

  const close = async () => {
    if (closed) return;
    closed = true;
    // A connect still in flight is waited out, then closed: nothing else would.
    const open = await client?.catch(() => undefined);
    await open
      ?.close()
      .catch((err) => logger.warn("chat pi mcp close failed", { err: String(err) }));
  };

  return {
    extensionFactories,
    ...(surface.instructions ? { instructions: surface.instructions } : {}),
    // `read_resource` is the chat's own, and only reads.
    lookupTools: new Set([
      ...surface.tools
        .filter((tool) => isLookupTool(tool))
        .map((tool) => stripMcpToolPrefix(tool.name)),
      READ_RESOURCE_TOOL,
    ]),
    surfaceCached: cached !== undefined,
    close,
  };
}

/** `work`, or `signal`'s abort reason; `work` goes on, as the turn's tool calls share it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Refuse a space a call names outside the turn's, or record it before the call is dispatched
 * there: the space is never defaulted.
 */
async function enterNamedSpace(
  organization: TurnSpaces,
  spaceId: unknown,
): Promise<Record<string, unknown> | undefined> {
  const refusal = spaceIdRefusal(organization.spaces, spaceId);
  if (refusal) return { ...refusal };
  await organization.touch(spaceId as string);
  return undefined;
}

/** Whether a tool declares a `space_id` it does not require, and the call omits it. */
function omitsOptionalSpace(inputSchema: unknown, args: Record<string, unknown>): boolean {
  const schema = (inputSchema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  return (
    args.space_id === undefined &&
    schema.properties?.space_id !== undefined &&
    !(Array.isArray(schema.required) && schema.required.includes("space_id"))
  );
}

/**
 * Record the spaces a platform result says it read (a search or a configuration refusal),
 * before the result is returned. The refusal that withholds the result when a listed space is not
 * the turn's or cannot be recorded; `undefined` when every one is recorded.
 */
async function recordResultSpaces(
  organization: TurnSpaces,
  listed: unknown,
): Promise<Record<string, unknown> | undefined> {
  if (listed === undefined) return undefined;
  const turnSpaces = new Set(organization.spaces.map((space) => space.id));
  const ids: unknown[] = Array.isArray(listed) ? listed : [null];
  const recorded =
    ids.every((id) => typeof id === "string" && turnSpaces.has(id)) &&
    (await Promise.all(ids.map((id) => organization.touch(id as string))).then(
      () => true,
      () => false,
    ));
  return recorded
    ? undefined
    : {
        code: "spaces_not_recorded",
        error: "The spaces this call read could not be recorded on the conversation.",
      };
}

/**
 * A refusal rendered as a tool result, as the platform renders its own (`refusalResult`): failed,
 * presented as the call `received` was.
 */
function refusalToolResult(
  refusal: Record<string, unknown>,
  received: RemoteToolResult,
  scope: OfferScope,
  turnBudget: PiTurnBudget,
) {
  return withTurnBudgetNote(
    mcpResultToPi(
      {
        content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }],
        isError: true,
        _meta: { [TOOL_PRESENTATION_META_KEY]: received._meta?.[TOOL_PRESENTATION_META_KEY] },
      },
      scope,
    ),
    turnBudget,
  );
}

/** A read of a skill's text, kept whole in the replay so its procedure still applies on later turns. */
function keepsSkillText(uri: unknown, resources: readonly object[]): boolean {
  return (
    typeof uri === "string" &&
    uri.startsWith(SKILL_URI_PREFIX) &&
    resources.every((resource) => "text" in resource)
  );
}

/** Generic forwarding Pi tool: verbatim `tools/call` → adapted Pi result. */
function makeForwardExtension(
  tool: { name: string; description?: string; inputSchema: unknown },
  getClient: () => Promise<AppstrateMcpClient>,
  opts: BuildPlatformMcpToolsOptions,
): ExtensionFactory {
  const { signal, turnBudget, organization } = opts;
  const toolName = stripMcpToolPrefix(tool.name);
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description ?? toolName,
      parameters: unsafeSchema<Record<string, unknown>>(
        (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
      ),
      async execute(toolCallId: string, params: unknown, execSignal?: AbortSignal) {
        const callSignal = execSignal ?? signal;
        const args = (params as Record<string, unknown>) ?? {};
        const spaceId = dispatchSpace(args);
        const client = await untilAborted(getClient(), callSignal);
        const received = await client.callTool(
          { name: tool.name, arguments: args },
          { signal: callSignal },
        );
        const scope = offerScopeOf(toolName, {
          arguments: params,
          relayed: isRelayedResult(received),
        });
        // The platform records each operation's resolved execution space before dispatch,
        // through the signed bearer's beforeMcpSpaceAct callback. Other disclosed spaces (a
        // search, or the alternatives on a refusal) can only be known from the result.
        const serverSpaces = received._meta?.[OPERATION_SPACES_META_KEY];
        const actedSpaceIds =
          Array.isArray(serverSpaces) &&
          serverSpaces.every(
            (id): id is string =>
              typeof id === "string" && organization.spaces.some((space) => space.id === id),
          )
            ? serverSpaces
            : undefined;
        if (serverSpaces !== undefined && !actedSpaceIds) {
          return refusalToolResult(
            {
              code: "spaces_not_recorded",
              error: "The operation returned a space outside this conversation.",
            },
            received,
            scope,
            turnBudget,
          );
        }
        const readSpaces =
          toolName === "invoke_operation" && received.isError
            ? received._meta?.[ACTIVE_SPACES_META_KEY]
            : spaceId === undefined && omitsOptionalSpace(tool.inputSchema, args)
              ? received.structuredContent?.searched_spaces
              : undefined;
        const unrecorded = await recordResultSpaces(organization, readSpaces);
        if (unrecorded) return refusalToolResult(unrecorded, received, scope, turnBudget);
        const result = assistantVisibleMcpResult(received);
        if (toolName === "call_integration_tool" && isRelayedResult(result)) {
          return withTurnBudgetNote(
            {
              ...(await relayedToolResult(result, scope, opts.fileDelivery.image)),
              ...(actedSpaceIds && { actedSpaceIds }),
            },
            turnBudget,
          );
        }
        // Only platform file reads may interpret embedded resources as governed files.
        const arg = args.arguments;
        if (
          toolName === "read" ||
          (toolName === "call_integration_tool" &&
            arg &&
            typeof arg === "object" &&
            "read_as_file" in arg &&
            arg.read_as_file === true)
        ) {
          const resources = result.content.flatMap((block) =>
            block.type === "resource" ? [block.resource] : [],
          );
          if (resources.length) {
            const meta = mcpResultToPi(
              { ...result, content: result.content.filter((block) => block.type !== "resource") },
              scope,
            );
            const file = await liveResources(resources, opts, toolCallId);
            return withTurnBudgetNote(
              {
                ...meta,
                ...(actedSpaceIds && { actedSpaceIds }),
                content: [...meta.content, ...file.content],
                ...(keepsSkillText(args.uri, resources)
                  ? {}
                  : {
                      persistedContent: [
                        ...meta.content.flatMap((block) => (block.type === "text" ? [block] : [])),
                        ...file.receipts,
                      ],
                    }),
              },
              turnBudget,
            );
          }
        }
        return withTurnBudgetNote(
          { ...mcpResultToPi(result, scope), ...(actedSpaceIds && { actedSpaceIds }) },
          turnBudget,
        );
      },
    });
  };
}

/**
 * `read_resource` Pi tool: `resources/read` on the platform MCP server, the
 * only server it reaches — how the model reads a skill's `SKILL.md` or one of
 * its files by its `skill://` URI. The same live projection serves embedded resources
 * from `read` and governed connector reads.
 */
function makeReadResourceExtension(
  getClient: () => Promise<AppstrateMcpClient>,
  opts: BuildPlatformMcpToolsOptions,
): ExtensionFactory {
  const { signal, turnBudget, organization } = opts;
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: READ_RESOURCE_TOOL,
      label: READ_RESOURCE_TOOL,
      description:
        "Read a resource of the Appstrate platform by its URI, such as a skill's SKILL.md or one of its files (`skill://…`). Returns bounded text, images or PDFs for the current model. Other formats return a description.",
      parameters: unsafeSchema<{ uri: string }>({
        type: "object",
        properties: {
          uri: {
            type: "string",
            description:
              "The resource URI. A skill's file sits next to its SKILL.md: replace `SKILL.md` in the skill's URI with the file's path.",
          },
        },
        required: ["uri"],
        additionalProperties: false,
      }),
      async execute(toolCallId: string, params: unknown, execSignal?: AbortSignal) {
        const callSignal = execSignal ?? signal;
        const uri = (params as { uri?: unknown } | null)?.uri;
        if (typeof uri !== "string" || uri === "") {
          throw new Error("`uri` must be a non-empty string");
        }
        const skillSpace = parseSkillUri(uri)?.spaceId;
        if (skillSpace) {
          const refusal = await enterNamedSpace(organization, skillSpace);
          if (refusal) {
            return withTurnBudgetNote(
              toPiToolResult(refusal, offerScopeOf(READ_RESOURCE_TOOL, { arguments: params })),
              turnBudget,
            );
          }
        }
        // The file's space is read before the read: a file deleted in between would otherwise be
        // served with its space unrecorded. The platform reads it in its own space when the
        // bearer may enter it and refuses any other as missing, so only a read it served records
        // that space, before its content leaves; a refused one records, and reveals, nothing.
        const fileSpace = isFileUri(uri) ? await organization.fileSpace(uri) : undefined;
        const client = await untilAborted(getClient(), callSignal);
        const result = await client.readResource({ uri }, { signal: callSignal });
        if (fileSpace && organization.spaces.some((space) => space.id === fileSpace)) {
          await organization.touch(fileSpace);
        }
        const { content, receipts } = await liveResources(result.contents, opts, toolCallId);
        return withTurnBudgetNote(
          {
            content,
            details: { uri },
            ...(keepsSkillText(uri, result.contents) ? {} : { persistedContent: receipts }),
          },
          turnBudget,
        );
      },
    });
  };
}

/** One projection for both MCP resource reads and embedded resources from governed tool calls. */
async function liveResources(
  resources: Awaited<ReturnType<AppstrateMcpClient["readResource"]>>["contents"],
  opts: Pick<BuildPlatformMcpToolsOptions, "fileDelivery" | "pdfInput">,
  toolCallId: string,
) {
  const content: PiToolResult["content"] = [];
  const receipts: NonNullable<PiToolResult["persistedContent"]> = [];
  for (const resource of resources) {
    const mimeType = normalizeMime(resource.mimeType) || "application/octet-stream";
    const text = "text" in resource ? resource.text : undefined;
    const blob = "blob" in resource ? resource.blob : "";
    const size = text !== undefined ? Buffer.byteLength(text) : Buffer.byteLength(blob, "base64");
    let note = "File read for this turn.";
    if (size > (text !== undefined ? RESOURCE_TEXT_MAX_BYTES : RESOURCE_BLOB_MAX_BYTES)) {
      note = RESOURCE_OVERSIZED_NOTE;
    } else if (text !== undefined) {
      content.push({ type: "text", text });
    } else if (mimeType === "application/pdf" && opts.pdfInput) {
      const name = resource._meta?.[FILE_NAME_META_KEY];
      const pdf = opts.pdfInput.add(
        { name: typeof name === "string" && name ? name : "document.pdf", data: blob },
        toolCallId,
      );
      if ("reference" in pdf) content.push({ type: "text", text: pdf.reference });
      else note = pdf.note;
    } else if (isRasterImageMime(mimeType) && opts.fileDelivery.image) {
      content.push({ type: "image", mimeType, data: blob });
    } else {
      note = "This file format cannot be read by the current model.";
    }
    const receipt = {
      type: "text" as const,
      text: JSON.stringify({ uri: resource.uri, mimeType, size, note }),
    };
    receipts.push(receipt);
    if (text === undefined || note === RESOURCE_OVERSIZED_NOTE) content.push(receipt);
  }
  return { content, receipts };
}

/**
 * The platform `run_and_wait` schema minus its `wait` argument: the chat's wait
 * descends from the turn's deadline, so the model is never offered one, and the
 * shared launch refuses it as an unknown argument.
 */
function withoutWaitArgument(inputSchema: unknown): Record<string, unknown> {
  const schema = (inputSchema as Record<string, unknown> | undefined) ?? { type: "object" };
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !("wait" in properties)) return schema;
  const { wait: _wait, ...rest } = properties;
  return { ...schema, properties: rest };
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
    /** Auth + org headers; the space rides in `X-Space-Id`, set per call from the space it names. */
    headers: Record<string, string>;
    /** The spaces one of which each call names. */
    organization: TurnSpaces;
    /** Transport for the launch POST and the poll loop — see the option above. */
    fetch: typeof fetch;
    writeChunk: (chunk: UIMessageChunk) => void;
    signal: AbortSignal;
    turnBudget: PiTurnBudget;
    inlineRunModel?: InlineRunModel;
  },
): ExtensionFactory {
  const runAndWaitScope = offerScopeOf(RUN_AND_WAIT_TOOL, {});
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: RUN_AND_WAIT_TOOL,
      label: RUN_AND_WAIT_TOOL,
      description: tool.description ?? "Launch an Appstrate run and wait for completion.",
      parameters: unsafeSchema<Record<string, unknown>>(withoutWaitArgument(tool.inputSchema)),
      async execute(toolCallId: string, params: unknown, execSignal?: AbortSignal) {
        // Taken out of the arguments (the shared launch refuses one it does not declare) and
        // recorded before anything is launched.
        const { space_id: explicit, ...args } = (params as Record<string, unknown> | null) ?? {};
        const spaceId =
          explicit !== undefined
            ? explicit
            : defaultMcpSpaceId(
                ctx.organization.spaces,
                ctx.organization.originSpaceId,
                args.kind === "inline",
              );
        const canLaunch = ({ permissions }: TurnSpaces["spaces"][number]) => {
          const has = (permission: string) => permissions.includes(permission);
          return has("mcp:read") && has("mcp:invoke") && canRunAgents(has);
        };
        const eligible = () =>
          ctx.organization.spaces.filter(
            (space) =>
              canLaunch(space) &&
              (args.kind !== "inline" || canComposeInline((p) => space.permissions.includes(p))),
          );
        if (spaceId === undefined) {
          // The model asks the user which of these spaces, then launches again with it.
          const allowed = eligible();
          if (allowed.length > 0)
            return withTurnBudgetNote(
              toPiToolResult(spaceIdRefusal(allowed, undefined), runAndWaitScope),
              ctx.turnBudget,
            );
        }
        const target = ctx.organization.spaces.find((space) => space.id === spaceId);
        if (spaceId !== undefined && !target) {
          return withTurnBudgetNote(
            toPiToolResult(spaceIdRefusal(ctx.organization.spaces, spaceId), runAndWaitScope),
            ctx.turnBudget,
          );
        }
        if (!target || !canLaunch(target)) {
          return withTurnBudgetNote(
            toPiToolResult(
              {
                code: "not_granted",
                error: "Your role does not allow launching and reading this run here.",
                granted_in: eligible().map(({ id, name }) => ({ id, name })),
              },
              runAndWaitScope,
            ),
            ctx.turnBudget,
          );
        }
        // REST rechecks the launch grants and can explain a missing inline authoring
        // permission together with the other spaces where the caller may compose.
        await ctx.organization.touch(target.id);
        let finalPayload: Record<string, unknown> = {
          error: "run_and_wait produced no result",
        };
        // The run's wait budget descends from the TURN's deadline (never the
        // 30-minute client default), and a launch with no room left is refused
        // here — before any run row exists.
        for await (const step of runAndWaitStepsWithinTurnBudget(args, {
          origin: ctx.origin,
          headers: { ...ctx.headers, "x-space-id": target.id },
          fetch: ctx.fetch,
          signal: execSignal ?? ctx.signal,
          // The chat holds the connect capability itself — the link goes to a
          // card, never to the model. See `RUN_CONNECT_OFFERS_HEADER` in
          // `@appstrate/core/run-and-wait-client`.
          connectOffers: true,
          ...(ctx.inlineRunModel ? { inlineRunModel: ctx.inlineRunModel } : {}),
          budget: {
            turnDeadlineAt: ctx.turnBudget.deadlineAt,
            chatSessionId: ctx.turnBudget.chatSessionId,
            ...(ctx.turnBudget.orgId ? { orgId: ctx.turnBudget.orgId } : {}),
            ...(ctx.turnBudget.now ? { now: ctx.turnBudget.now } : {}),
          },
        })) {
          finalPayload = step.payload;
          if (step.isError) {
            // This tool launches over REST. Restrict its alternatives to the same tool and
            // record them before any preliminary card, tool result or history can reveal them.
            const projected = projectActiveInSpaces(step.payload.body, eligible);
            if (projected) {
              const unrecorded = await recordResultSpaces(ctx.organization, projected.ids);
              if (unrecorded) {
                return withTurnBudgetNote(
                  toPiToolResult(unrecorded, runAndWaitScope),
                  ctx.turnBudget,
                );
              }
              finalPayload = { ...step.payload, body: projected.body };
            }
          }
          // Live card: push each step's payload under this tool call id so the
          // UI reflects launch → progress → terminal before execute resolves.
          // `preliminary` (AI SDK): the call is not settled until the result below.
          ctx.writeChunk({
            type: "tool-output-available",
            toolCallId,
            output: {
              ...toPiToolResult(finalPayload, runAndWaitScope),
              actedSpaceIds: [target.id],
            },
            preliminary: true,
          });
        }
        // The final step is ALSO delivered as the tool result (tool_execution_end
        // re-emits it under the same id — an idempotent update to the same card).
        // That last write is the one the card keeps, and it carries the budget
        // note appended to `content` — the very channel the card parses.
        return withTurnBudgetNote(
          { ...toPiToolResult(finalPayload, runAndWaitScope), actedSpaceIds: [target.id] },
          ctx.turnBudget,
        );
      },
    });
  };
}
