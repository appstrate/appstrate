// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/orgs/:orgId/chat` — the conversational loop, ported from the appstrate-chat
 * satellite (routes/chat.ts) with two changes:
 *
 *   1. Identity: the satellite carried two audience-bound OAuth tokens; the
 *      module's loopback calls carry a short-lived bearer it mints (loopback-auth.ts).
 *   2. Persistence: server-authoritative. This route writes the user turn
 *      before inference and the assistant turn when the stream finalizes
 *      (see persistence.ts). Generation runs through a resumable producer
 *      (resumable.ts) that drains to completion independently of the client
 *      connection, so leaving the conversation mid-inference does not drop
 *      messages. The client history adapter is now load-only.
 *
 * Inference goes through the llm-proxy for API-key models and natively at
 * the provider for OAuth subscriptions (no key here); tool calls dispatch
 * through `/api/mcp` (auth + RBAC re-applied in-process).
 */

import type { Context } from "hono";
import { safeValidateUIMessages, type FileUIPart, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { invalidRequest, conflict, forbidden } from "@appstrate/core/api-errors";
import { readJsonBody } from "@appstrate/core/request-body";
import { withByteCap } from "@appstrate/core/safe-json";
import { isAttachmentUri, parseFileUri } from "@appstrate/core/file-uri";
import { logger } from "./logger.ts";
import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "./agent-prompt.ts";
import { resolveAgentPrompt, withStoredAgentPromptTexts } from "./agent-launch.ts";
import { notifySessionUpdate } from "./realtime.ts";
import { listModels, pickModel } from "./llm.ts";
import { actingOrgRole, callerMcpOpener, dispatchFetch, platformMcpUrl } from "./platform-mcp.ts";
import { platformMcpSurfaceKey } from "./pi-chat/mcp-surface-cache.ts";
import { selfOrigin } from "./self.ts";
import type { ChatUsageRecord, InjectedSkills } from "@appstrate/core/chat-contract";
import { mintLoopbackToken, mintMcpLoopbackToken } from "./loopback-auth.ts";
import {
  materializeUserAttachments,
  uploadResolutionsChunk,
  withStoredHistoryFiles,
} from "./attachments.ts";
import { runPiChat, type PiChatInput } from "./pi-chat/engine.ts";
import { resolvePiChatModelBinding } from "./pi-chat/model-binding.ts";
import { acquirePiChatSlot, chatCapacityError } from "./pi-chat/concurrency.ts";
import {
  limitedConversationPermissions,
  turnPermissions,
  turnUsesDrafts,
} from "./turn-permissions.ts";
import { buildSystemPrompt, buildCallerContextBlock, type ChatEnv } from "./prompt.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import {
  applySkillChanges,
  DEFAULT_SKILL_SELECTION,
  MAX_PINNED_SKILLS,
  turnSkillLoad,
  type ChatSkillChanges,
  type PinnedSkillStatus,
} from "./skills.ts";
export type { ChatEnv } from "./prompt.ts";
import { finalizeChatStream } from "./finalize-stream.ts";
import {
  ensureSession,
  fileSpaceId,
  type TurnConversation,
  persistUserMessage,
  persistAssistantMessage,
  pinAssistantSkill,
  storedFileParts,
  storedAgentPromptTexts,
  touchSessionSpace,
} from "./persistence.ts";
import { registerStopController, unregisterStopController } from "./stop-registry.ts";
import { setActiveStream, clearActiveStream, type TurnScope } from "./resumable.ts";
import {
  actingSpaces,
  conversationOrigin,
  readableSpaceIds,
  type ChatPlatformDeps,
} from "./platform-services.ts";
import type { TurnSpaces } from "./pi-chat/mcp-tools.ts";
import type { UsageRejection } from "@appstrate/core/module";
import { turnCapabilities } from "./capabilities.ts";
import { classifyClientTurnError, clientTurnErrorMarker, turnErrorLogIds } from "./turn-error.ts";
import {
  ModelGenerationError,
  modelGenerationSettingsSchema,
  resolveModelGenerationSettings,
} from "@appstrate/core/model-generation";

/**
 * RFC 9457 response for a turn blocked by the platform admission gate
 * (`beforeUsage`, chat context). The hook's status flows through — a metering
 * module returns 402 (payment required) when the org is over its soft cap.
 */
function usageRejectionResponse(rejection: UsageRejection): Response {
  const status = rejection.status ?? 403;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/usage-not-allowed",
      title: "Usage not allowed",
      status,
      detail: rejection.message,
      code: rejection.code,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * TTL for the Pi-engine path's loopback bearer. The Pi chat engine
 * opens its platform MCP client once per turn with these headers, so the token
 * must outlive the whole turn (up to CHAT_MAX_STEPS steps, each able to
 * long-poll a run's status for ~55 s). 30 min is a generous ceiling for a
 * single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

/**
 * The engine that drives a turn. Injectable ONLY so tests can script a turn
 * without standing up a real Pi session against a real provider — production
 * always gets {@link runPiChat}. There is no second engine to select.
 */
export type ChatEngine = (input: PiChatInput) => Response;

/**
 * Roles the engine's history projection actually handles. `buildStructuredPiTurn`
 * (`pi-chat/structured-session.ts`) keeps `user` and `assistant` and DROPS every
 * other role silently, so anything else must be refused at the door rather than
 * accepted and discarded.
 */
const CHAT_MESSAGE_ROLES = new Set(["user", "assistant"]);

/** Ceiling on the turn's last (persisted) message; attachments ride as references. */
export const CHAT_MESSAGE_MAX_BYTES = 256 * 1024;

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. The last message's UIMessage shape is checked by
// `safeValidateUIMessages` in the handler; this schema adds:
//   - `role` MUST be one of {@link CHAT_MESSAGE_ROLES}. Nothing legitimate
//     sends another: the composer only produces user turns, and a reload
//     replays what the server persisted — user or assistant, a server-authored
//     notice included (persistence.ts stores it as `assistant`).
//   - any `file` part MUST reference an `upload://` or `appfile://` URI. That
//     rejects inline `data:` bytes and arbitrary URLs in the chat channel
//     (attachments flow only through the file store, never inline).
//   - an `agent-prompt` part (`agent-prompt.ts`) is a user message's, at most one, and its data
//     parses; `handleChatStream` resolves it.
//   - `pin_skills` / `unpin_skills` are deltas against the stored pins, never a full set, so a
//     stale client cannot drop a pin the assistant added (`ensureSession` applies them).
//   - `.strict()`: an unknown field is a 400, never silently dropped.
const skillIdsSchema = z
  .array(z.string().regex(scopedNameRegex, { error: "Must be a package id in @scope/name form" }))
  .max(MAX_PINNED_SKILLS, { error: `At most ${MAX_PINNED_SKILLS} skills` });

export const chatStreamSchema = z
  .object({
    id: z.string().optional(),
    messages: z
      .array(z.unknown())
      .min(1, "messages must not be empty")
      .superRefine((messages, ctx) => {
        messages.forEach((message, i) => {
          const role = (message as { role?: unknown }).role;
          if (typeof role !== "string" || !CHAT_MESSAGE_ROLES.has(role)) {
            ctx.addIssue({
              code: "custom",
              message: "Message role must be 'user' or 'assistant'.",
              path: [i, "role"],
            });
          }
          const parts = (message as { parts?: unknown }).parts;
          if (!Array.isArray(parts)) return;
          let launches = 0;
          parts.forEach((part, j) => {
            const type =
              part && typeof part === "object" ? (part as { type?: unknown }).type : null;
            if (type === AGENT_PROMPT_PART_TYPE) {
              const parsed = agentPromptDataSchema.safeParse((part as { data?: unknown }).data);
              if (role !== "user" || ++launches > 1 || !parsed.success) {
                ctx.addIssue({
                  code: "custom",
                  message:
                    "A user message carries at most one agent launch, { name, title } (and the text a stored one holds).",
                  path: [i, "parts", j, "data"],
                });
              }
              return;
            }
            if (type !== "file") return;
            const url = (part as { url?: unknown }).url;
            if (!isAttachmentUri(url)) {
              ctx.addIssue({
                code: "custom",
                message: "File attachment URI must be an 'upload://' or 'appfile://' URI.",
                path: [i, "parts", j, "url"],
              });
            }
          });
        });
        withByteCap(CHAT_MESSAGE_MAX_BYTES)(messages.at(-1), ctx);
      }),
    modelId: z.string().optional(),
    /**
     * The origin space and limit of the conversation, read ONLY when this turn creates its
     * row (an existing conversation keeps its own). Absent from the overview (no default).
     */
    spaceId: z.string().min(1).optional(),
    restricted: z.boolean().optional(),
    generation: modelGenerationSettingsSchema.optional(),
    /** The composer's package-authoring switch; absent = on. See {@link turnPermissions}. */
    package_authoring: z.boolean().optional(),
    /** Runs the inline runs this turn launches on its model and generation; absent = off. */
    inline_runs_use_chat_model: z.boolean().optional(),
    /** The conversation's skill discovery switch; absent = the one stored on the session. */
    skill_discovery: z.boolean().optional(),
    /** Skills to pin to the conversation, on top of the stored ones. */
    pin_skills: skillIdsSchema.optional(),
    /** Skills to unpin from the conversation, whoever pinned them. */
    unpin_skills: skillIdsSchema.optional(),
  })
  .strict();

function logAndMarkStreamError(error: unknown, requestId: string): string {
  const shown = classifyClientTurnError(error, requestId);
  logger.error("chat turn stream failed", {
    err: String(error),
    ...turnErrorLogIds(requestId, shown),
  });
  return clientTurnErrorMarker(shown);
}

/**
 * Claim the conversation for this turn: set its in-flight marker, before anything
 * of the turn is written — its attachments, its touched spaces, its user message.
 * A conversation runs one turn at a time (`setActiveStream`), so a refused claim
 * leaves nothing behind: 409 `chat_turn_scope_changed` when the scope the turn read
 * moved (a resend computes it afresh), 409 `chat_turn_in_flight` while another turn
 * holds the conversation.
 *
 * THE ORDER IS THE INVARIANT, not a preference. Chat persistence has a second
 * writer — `persistNotice`, driving the orphaned-run reconciliation — and the
 * rule it obeys is "a turn owns its conversation from start to finalize",
 * evaluated as `chat_sessions.active_stream_id IS NULL` under the session row's
 * lock. Were the user message written before the claim, that predicate would be
 * TRUE while a turn was already under way: `onRunStatusChange` →
 * `reconcileChatRun` → `persistNotice` would take the lock, legitimately see
 * NULL, and commit a notice at the seq BETWEEN this turn's user message and its
 * assistant message — user / notice / assistant, and the session marked unread
 * while its owner sat watching it generate.
 *
 * Claiming first costs nothing that anything reads back. The two things that
 * consult the marker both treat "set, but no live producer" as no stream: the
 * resume GET answers 204 when the store has no producer for the id (`routes.ts`),
 * and `POST …/stop` looks the id up in the stop registry, where this turn's
 * controller is registered a few statements later. What is briefly true is the
 * DTO's `generating` flag, and that is simply the truth: the turn has started.
 *
 * The claim also records the turn's verdict on each pin (`skill_status`), so a refused turn
 * records none.
 */
export async function claimTurn(
  sessionId: string,
  streamId: string,
  scope: TurnScope,
  skillStatus: Readonly<Record<string, PinnedSkillStatus>>,
): Promise<void> {
  const claim = await setActiveStream(sessionId, streamId, scope, skillStatus);
  if (claim === "scope_changed") {
    throw conflict(
      "chat_turn_scope_changed",
      "The conversation's limit or skill settings changed while this turn was starting. Send the message again.",
    );
  }
  if (claim === "in_flight") {
    throw conflict(
      "chat_turn_in_flight",
      "A turn is already running in this conversation. Send the message again once it ends.",
    );
  }
}

/**
 * Write the user message of a turn that holds its claim ({@link claimTurn}) and
 * return its id, which the assistant turn derives its own id from. A claim must not
 * outlive the turn it was taken for: on a failed write the marker is cleared, else the
 * session stays generating forever — the resume GET keeps answering 204,
 * `persistNotice` keeps refusing, the sidebar keeps a spinner.
 */
export async function persistClaimedUserMessage(
  sessionId: string,
  streamId: string,
  message: UIMessage,
): Promise<string> {
  try {
    return await persistUserMessage(sessionId, message);
  } catch (err) {
    await clearActiveStream(sessionId, streamId).catch(() => {});
    throw err;
  }
}

/**
 * Write a turn's usage row without holding the stream, then signal its conversation: the row
 * lands after the turn's own persistence signal, and the detail reads the ledger. Never throws:
 * the engine calls it from its `finally`, ahead of the MCP close, so a write that throws
 * synchronously is logged like a rejected one.
 */
export function recordTurnUsage(
  record: ChatUsageRecord,
  write: (record: ChatUsageRecord) => Promise<void>,
  notify: typeof notifySessionUpdate = notifySessionUpdate,
): void {
  void Promise.resolve()
    .then(() => write(record))
    .then(
      () => {
        if (record.chatSessionId) notify(record.chatSessionId, record.orgId, record.userId);
      },
      (err: unknown) => {
        logger.warn("chat usage metering failed", { err: String(err) });
      },
    );
}

export async function handleChatStream(
  c: Context<ChatEnv>,
  deps: ChatPlatformDeps,
  runEngine: ChatEngine = runPiChat,
): Promise<Response> {
  // The loopback strategy declares `principalKind: "user"` for whatever it verifies, so a token
  // may only ever be minted from one — `chat:*` is neither key- nor end-user-grantable today, and
  // this refuses rather than silently widens if that ever changes.
  if (c.get("principalKind") !== "user") {
    throw new Error(`chat loopback minted for a ${c.get("principalKind")} principal`);
  }
  const orgId = c.get("orgId");
  const user = c.get("user");
  const requestId = c.get("requestId");
  // The spaces the caller reaches, of which the acting set is the part the turn may act in;
  // each call of the turn is decided in the space it names. The conversation's own limit and
  // origin space narrow it once its row is known (`turn` below).
  const reachable = c.get("reachable");
  const acting = actingSpaces(reachable);
  // Where the conversation's own uploads live, reached through it rather than through a space.
  const personalSpaceId = reachable.find((space) => space.personal)?.id ?? null;
  // While a preview is on, the turn is answered as the persona; the real role
  // stays on the context for identity and audit.
  const persona = c.get("viewAs");
  const orgRole = actingOrgRole(c);
  const body = await readJsonBody(c, chatStreamSchema);
  // The client sends its selected history branch along with the new message.
  const validated = await safeValidateUIMessages({ messages: body.messages.slice(-1) });
  if (!validated.success) {
    throw invalidRequest(`Invalid chat message: ${validated.error.message}`, "messages");
  }
  let messages = [...(body.messages.slice(0, -1) as UIMessage[]), ...validated.data];
  // The origin space and limit ride the turn but are read only by the turn that CREATES the
  // conversation (`ensureSession` validates them then): an existing one keeps its own.
  const asksOrigin = body.spaceId !== undefined || body.restricted === true;
  const originRequest = asksOrigin ? () => conversationOrigin(reachable, body) : undefined;
  logger.info("chat turn", { turns: messages.length });

  const sessionId = body.id;
  let lastMessage = messages[messages.length - 1] as UIMessage | undefined;

  // The session the turn persists to, null for an ephemeral turn: every use of the
  // conversation's id below takes this one, so a turn reaches what it attached.
  const chatSessionId = sessionId && lastMessage?.id ? sessionId : null;

  const turnStart = Date.now();

  // Persist the session ROW up front, BEFORE the (potentially multi-second)
  // inference preamble (model resolve + MCP boot). The client mints the id and
  // creates conversations lazily, so the sidebar shows a new conversation
  // optimistically on send; without an early `ensureSession` the row would not
  // exist until after the preamble, and the sidebar's reconciling poll could
  // fire first and clobber the optimistic entry (flicker). Creating the row here
  // closes that window. Ownership is enforced inside `ensureSession` (404 on a
  // foreign-tenant id collision). The user MESSAGE and the `active_stream_id`
  // marker are still written later, just before generation — keeping the
  // "generating" flag off until we're committed to a turn, so a preamble error
  // can't strand the session as perpetually generating.
  //
  // Started here, NOT awaited here: it depends on nothing but ids, so it runs
  // concurrently with the phase-A reads below and is joined in the same
  // `Promise.all` — a foreign-tenant 404 still surfaces before anything is
  // materialized into the session, and attaching the join in the same tick is
  // what keeps a rejection from ever going unhandled.
  //
  // The panel's changes ride the turn and are applied in the same upsert, so
  // nothing is stored before the first message; without any the row's stand.
  const skillChanges: ChatSkillChanges = {
    ...(body.skill_discovery !== undefined && { skillDiscovery: body.skill_discovery }),
    pin: body.pin_skills ?? [],
    unpin: body.unpin_skills ?? [],
  };
  // An ephemeral turn writes no row: it creates, so its origin is validated here, and its
  // changes apply to the default selection.
  const ephemeralConversation = (): TurnConversation => {
    const created = originRequest?.();
    return {
      selection: {
        skillDiscovery: skillChanges.skillDiscovery ?? DEFAULT_SKILL_SELECTION.skillDiscovery,
        pinnedSkills: applySkillChanges(DEFAULT_SKILL_SELECTION.pinnedSkills, skillChanges),
      },
      spaceId: created?.spaceId ?? null,
      restricted: created?.restricted ?? false,
    };
  };
  const conversation: Promise<TurnConversation> =
    sessionId && lastMessage?.id
      ? ensureSession(
          sessionId,
          orgId,
          user.id,
          readableSpaceIds(reachable),
          skillChanges,
          originRequest,
        )
      : Promise.resolve(ephemeralConversation());
  // The earlier turns' files, read once the row is known to be the caller's. An ephemeral
  // turn has no stored row, so its history carries no file.
  const historyIds = messages
    .slice(0, -1)
    .flatMap((message) => (typeof message.id === "string" ? [message.id] : []));
  const historyStored = conversation.then(async () =>
    sessionId && lastMessage?.id
      ? {
          files: await storedFileParts(sessionId, historyIds),
          launches: await storedAgentPromptTexts(sessionId, historyIds),
        }
      : { files: new Map<string, FileUIPart[]>(), launches: new Map<string, string>() },
  );

  const origin = selfOrigin();
  // Single platform-call seam: re-enter the platform app in-process (or loopback
  // fetch when not wired) for every PLATFORM read the turn makes (/api/models
  // and the MCP hops).
  // Auth + RBAC run each hop.
  //
  // Inference is the exception and does NOT ride this seam: the proxy binding
  // hands pi-ai a `baseUrl` string built from `origin`, and pi-ai opens a real
  // loopback socket to it. That is why `CHAT_SELF_ORIGIN` must actually resolve
  // on this host, and why the binding needs a bearer *minter* (see below) rather
  // than a header captured once.
  const platformFetch = dispatchFetch(deps);

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own grants (full RBAC fidelity on tool calls, narrowed by
  // `turnPermissions` when package authoring is off).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // many steps (with a run long-poll blocking for ~55s between them), so the
  // proxy binding gets a *minter* and re-mints a fresh bearer immediately before
  // every provider request. The static header below is for the one-shot calls
  // (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      // The session id rides the SIGNED loopback claims (not a header) so the
      // llm-proxy can attribute a proxy-routed turn's usage to the chat session
      // without trusting anything spoofable.
      { chatSessionId },
    );
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // ── Preamble phase A ─────────────────────────────────────────────────────
  // `listModels` resolves the row the turn binds to. The spaces are NOT looked up:
  // the router's middleware read the reach before this handler ran, and `reachable` is
  // that answer — reading `/api/spaces` again would be a second, divergent one.
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;

  // Flipping a switch changes the system prompt and, through the narrowed token, the
  // MCP tool descriptors on the same turn: one prompt-cache miss. The skill selection, the
  // origin space and the limit live on the session row, so the turn's scope follows its upsert.
  const turn = conversation.then((conv) => {
    // The origin space, while the caller can still act there.
    const originSpace = acting.find((space) => space.id === conv.spaceId);
    // A limited conversation acts in its origin space alone, and is refused once it cannot.
    if (conv.restricted && !originSpace) {
      throw forbidden(
        "This conversation is limited to its origin space, where you can no longer act.",
      );
    }
    const spaces = conv.restricted && originSpace ? [originSpace] : acting;
    // The caller's grants this turn starts from: the union over the turn's spaces. It is a
    // CEILING on the bearer (each space entry recomputes `(org ∪ role) ∩ ceiling`,
    // `lib/auth-pipeline.ts`), so no space's grants reach another. A limited conversation keeps
    // of the org-level half only the reads it needs: it changes nothing serving every space.
    const union = spaces.flatMap((space) => space.permissions);
    const callerPermissions: ReadonlySet<string> = new Set(
      conv.restricted ? limitedConversationPermissions(union, c.get("reachableOrgHalf")) : union,
    );
    const permissions = turnPermissions(callerPermissions, {
      authoring: body.package_authoring !== false,
      skillDiscovery: conv.selection.skillDiscovery,
    });
    const capabilities = turnCapabilities((permission) => permissions.includes(permission), spaces);
    // A conversation acts in the spaces of its turn alone and records each one it acts in
    // (see `touchSessionSpace`; the origin space is touched by definition): a space a call names,
    // or the space of a file `read_resource` reads, before the call, refused outside the set;
    // search records the spaces that contributed an entry to its result (`searched_spaces`), and
    // a launch refusal records the spaces whose activation state it discloses, before any result
    // or card is shown.
    // Skills are procedures, not data: injecting one touches no space.
    const organization: TurnSpaces = {
      spaces,
      touch: async (touchedSpaceId) => {
        if (!chatSessionId) return;
        await touchSessionSpace(
          { id: chatSessionId, orgId, userId: user.id, originSpaceId: conv.spaceId },
          touchedSpaceId,
        );
      },
      fileSpace: async (uri) => {
        const fileId = parseFileUri(uri);
        return fileId ? fileSpaceId(orgId, fileId, { chatSessionId, personalSpaceId }) : undefined;
      },
    };
    return {
      skills: conv.selection,
      // Whether the turn works on the caller's drafts (see `buildCallerContextBlock`).
      skillDrafts: turnUsesDrafts(callerPermissions, {
        authoring: body.package_authoring !== false,
      }),
      // The caller's own connection over the turn's spaces (see `callerMcpOpener`): the turn's
      // skills and an agent launch's prompt are read through it.
      openCaller: callerMcpOpener(c, platformFetch, {
        permissions: callerPermissions,
        spaces,
        restricted: conv.restricted,
      }),
      // As read: the claim compares the row against it (`claimTurn`).
      scope: {
        spaceId: conv.spaceId,
        restricted: conv.restricted,
        pinnedSkills: conv.selection.pinnedSkills,
        skillDiscovery: conv.selection.skillDiscovery,
      },
      originSpace,
      restricted: conv.restricted,
      spaces,
      organization,
      permissions,
      capabilities,
    };
  });
  const phaseAStart = Date.now();

  // ── Preamble phase B (overlapped with A) ─────────────────────────────────
  // The caller-context block. It depends on the reach and the session row (the
  // turn's grants and its skills) — never on the chosen model or the admission
  // gate — so it starts the moment the row resolves, overlapping the model list, the attachment materialization, the
  // credential resolution and the gate rather than waiting behind them. A turn the gate
  // rejects has read its skills for nothing, which is acceptable — what a rejected turn
  // must not do is persist a user message, record a space on the conversation (an
  // attachment's or a call's), open an MCP session for the engine or record usage, none of
  // which happen before the gate.
  //
  // There is NO platform-MCP probe here: the Pi engine opens its OWN MCP
  // connection from `platformMcp.url`, and the MCP server's instructions reach
  // the model through that handshake. Probing here would be a second handshake
  // we'd immediately close — 2 round-trips wasted on the TTFT path. We pass
  // `platformMcp` optimistically; if the `mcp` module is absent the engine just
  // gets no tools.
  //
  // The promise settles to a RESULT and never rejects: every early return
  // between here and the point the block is consumed (invalid generation
  // settings, a gate rejection) would otherwise leave a rejection with no
  // handler. The error is rethrown where the block is consumed.
  const phaseBStart = Date.now();
  let phaseBMs = 0;
  const contextBlockPromise: Promise<
    | {
        ok: true;
        block: string;
        injectedSkills: InjectedSkills;
        skillStatus: Record<string, PinnedSkillStatus>;
        skillBudgetLeft: number;
        skillUris: Map<string, string>;
      }
    | { ok: false; error: unknown }
  > = turn
    .then(
      ({
        skills,
        skillDrafts,
        permissions,
        capabilities,
        spaces,
        originSpace,
        restricted,
        openCaller,
      }) =>
        buildCallerContextBlock(c, {
          spaces,
          origin: originSpace,
          restricted,
          user,
          // UI language forwarded by the client; validated/defaulted in the builder.
          locale: c.req.header("X-Chat-Locale"),
          capabilities,
          permissions,
          skills,
          drafts: skillDrafts,
          // The turn's skills are read before the claim naming them exists, so
          // over a connection of the caller's own: not narrowed by `turnPermissions`, and no
          // claim — what the caller reads.
          // One in-process `initialize` plus the reads, only on a turn that lists
          // (discovery with `skills:read`) or injects skills; closed before the turn's
          // connection opens.
          openSkillsClient: openCaller,
        }).finally(() => {
          phaseBMs = Date.now() - phaseBStart;
        }),
    )
    .then(
      ({ text, injected, skillStatus, skillBudgetLeft, skillUris }) => ({
        ok: true as const,
        block: text,
        injectedSkills: injected,
        skillStatus,
        skillBudgetLeft,
        skillUris,
      }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  const [models, { permissions, capabilities, spaces, organization, scope, openCaller }, stored] =
    await Promise.all([listModels(origin, inferenceHeaders, platformFetch), turn, historyStored]);
  messages = withStoredAgentPromptTexts(
    withStoredHistoryFiles(messages, stored.files),
    stored.launches,
  );
  let chosen;
  try {
    chosen = pickModel(models, modelId);
  } catch (error) {
    logger.info("chat turn refused: no usable model", {
      orgId,
      requested: modelId ?? null,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  let generationSettings;
  try {
    generationSettings = resolveModelGenerationSettings({
      capabilities: chosen.generation,
      override: body.generation,
    });
  } catch (error) {
    if (error instanceof ModelGenerationError) throw invalidRequest(error.message);
    throw error;
  }
  const phaseAMs = Date.now() - phaseAStart;
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });

  // Which credential the turn spends. The platform resolves the chosen model
  // row: an API-key/unknown provider yields `{ subscription: false }` and the
  // turn is bound to the llm-proxy; an oauth2 provider yields the real upstream
  // binding + a fresh access token, or a reconnect signal when its credential is
  // dead. Both ride the SAME engine — this fact drives admission and the Pi
  // binding, never a choice of loop.
  const subscription = await deps.resolveChatModel(orgId, chosen.id, user.id);
  const isSubscription = subscription.subscription;

  // Admission gate — EVERY turn. The platform resolves the chosen model for the
  // session user server-side and dispatches `beforeUsage` (chat context) with
  // who pays it; a metering module quotes it and decides.
  //
  // A subscription turn is gated like any other. Its `credentialSource` is the
  // owner of the credential it spends — `user` for the member's own
  // subscription, `org` for the organization's — and the turn is driven by the
  // IN-PROCESS Pi engine: the platform funds its compute even when it funds no
  // inference, and a module gating on subscription status must be able to
  // refuse it.
  //
  // Gated BEFORE the caller-context block is consumed, the attachments are
  // materialized, the model binding is resolved and capacity is reserved, so a
  // rejected turn opens no MCP session, touches no space and persists no user
  // message. (The block's read may already be in flight — see phase B above — but
  // nothing is written until the gate has answered.)
  const rejection = await deps.checkUsageAllowed({
    orgId,
    presetId: chosen.id,
    sessionId: chatSessionId,
    userId: user.id,
  });
  if (rejection) {
    const refused = usageRejectionResponse(rejection);
    logger.info("chat turn refused by admission gate", {
      code: rejection.code,
      status: refused.status,
      orgId,
      model: chosen.id,
    });
    return refused;
  }

  // Join phase B. This is the one place its failure is allowed to surface.
  const contextResult = await contextBlockPromise;
  if (!contextResult.ok) throw contextResult.error;
  const {
    block: contextBlock,
    injectedSkills,
    skillStatus,
    skillBudgetLeft,
    skillUris,
  } = contextResult;

  // Assemble the system prompt: the tool-grounding prompt, with no inline MCP
  // instructions — the engine's own MCP handshake delivers them.
  //
  // The operation-index policy is NOT applied here. The index only ever enters a
  // prompt through the MCP server's `instructions`, which this route does not
  // fetch; the engine appends them and applies the policy itself
  // (`pi-chat/engine.ts`). Re-applying it to this prompt would match nothing — and
  // could only misfire, since the context block below carries org-authored names
  // (spaces, skills) and would be truncated at any that happened to spell the heading.
  // The block always opens with its own heading, so it is never empty.
  const system = `${buildSystemPrompt(capabilities)}\n\n${contextBlock}`;

  // Which credential the turn spends. One engine drives them both.
  const credentialMode = isSubscription ? "oauth2" : "api-key";

  // Resolve the new turn's agent launch, if it carries one: `prompts/get` over the caller's
  // connection in the turn's spaces, a read that changes nothing. Its answer is written into the
  // part before the turn is persisted, so the thread, the model and every replay share it. Before
  // the slot and the claim, so a refused launch has nothing to undo.
  if (lastMessage) {
    lastMessage = await resolveAgentPrompt(lastMessage, openCaller);
    messages[messages.length - 1] = lastMessage;
  }

  // Resolve the model binding and reserve capacity before the user message or
  // the active-stream marker is written, so a dead credential, an unsupported
  // family or a saturated process leaves no half-written turn behind. Once
  // acquired, the slot is transferred to the engine, which releases it when the
  // response stream closes.
  const resolution = resolvePiChatModelBinding({
    model: chosen,
    subscription,
    origin,
    mintBearer: mintInferenceAuth,
  });
  if (resolution.status === "needs-reconnection") {
    // The oauth credential is dead → tell the client to reconnect rather than
    // launching a session that would 401 upstream (409: the model's, not the caller's).
    throw conflict(
      "needs_reconnection",
      "The selected model's subscription credential expired or was revoked.",
    );
  }
  if (resolution.status !== "ready") {
    throw invalidRequest(`Model family "${chosen.apiShape}" is not supported by the chat.`);
  }
  const slot = acquirePiChatSlot();
  if (!slot) throw chatCapacityError();
  const modelBinding = resolution.binding;

  // Per-turn resumable stream id. It is the key for both the resumable producer
  // (live reconnect) and the stop registry, and is stored on the session as
  // `active_stream_id` so a reloaded client's resume GET can find the live turn.
  const streamId = crypto.randomUUID();

  // ── Server-authoritative persistence + resumable streaming ───────────────
  // The order: claim the conversation, materialize the attachments, persist the user
  // turn, then generate; the assistant turn is persisted when the stream finalizes
  // (in `finalize` below). Generation runs through a resumable producer that drains to
  // completion independently of the client, so leaving the conversation mid-inference
  // cannot drop messages. Every refusal before this point (the admission gate, the model
  // binding, capacity) and the claim's own refusal write no message, marker or skill status
  // into the conversation. The turn's skill changes are the exception: `ensureSession` applied
  // them at the top of the handler, so they stand even when the turn is refused.
  const claimedSessionId = sessionId && lastMessage?.id ? sessionId : undefined;
  let claimTurnMs = 0;
  if (claimedSessionId) {
    const claimStart = Date.now();
    try {
      await claimTurn(claimedSessionId, streamId, scope, skillStatus);
    } catch (err) {
      // The slot is reserved but generation has not started, so neither `finalize`
      // nor `failCleanup` (below) owns it yet.
      slot.release();
      throw err;
    }
    claimTurnMs = Date.now() - claimStart;
  }

  // Materialize the new turn's composer attachments into durable, session-scoped
  // files and rewrite each `upload://` (or already-`appfile://`) file part
  // to its stable `appfile://` URI, before the turn is persisted (persistence
  // stores only `appfile://`) and before it reaches the engine (the model is
  // shown the attachment as a text line, never a raw file URL). After the claim,
  // because resolving an attachment touches its space on the conversation, which a
  // refused turn must not widen. Only the last message can carry fresh uploads:
  // earlier turns took their files from their stored rows (`withStoredHistoryFiles`).
  // A file resolves in the turn's spaces; the conversation's own uploads in the caller's personal
  // space, which a limited turn does not act in.
  const attachmentSpaces = spaces.map((space) => ({
    id: space.id,
    permissions: new Set(space.permissions),
  }));
  // What the browser's optimistic `upload://` parts became, for the stream to tell it.
  let uploadResolutions: UIMessageChunk | null = null;
  if (chatSessionId && lastMessage) {
    const sent = lastMessage;
    try {
      lastMessage = await materializeUserAttachments(lastMessage, async (uri) => {
        return deps.resolveChatAttachment({
          orgId,
          userId: user.id,
          chatSessionId,
          uri,
          spaces: attachmentSpaces,
          personalSpaceId,
          // A gallery file's space is touched by the session that comes to hold it, before
          // it is attached; an upload lands in the personal space and touches none.
          beforeResolve: organization.touch,
        });
      });
    } catch (err) {
      slot.release();
      if (claimedSessionId) await clearActiveStream(claimedSessionId, streamId).catch(() => {});
      throw err;
    }
    messages[messages.length - 1] = lastMessage;
    uploadResolutions = uploadResolutionsChunk(sent, lastMessage);
  }

  let userMessageId: string | undefined;
  let persistUserMessageMs = 0;
  if (claimedSessionId && lastMessage) {
    const persistStart = Date.now();
    try {
      userMessageId = await persistClaimedUserMessage(claimedSessionId, streamId, lastMessage);
    } catch (err) {
      // The claim is already undone; the slot is this function's to undo.
      slot.release();
      throw err;
    }
    persistUserMessageMs = Date.now() - persistStart;
  }

  // Everything before generation, for an ADMITTED turn: the two overlapped
  // phases (their wall times, not a sum — phase B may outlast phase A),
  // the claim and user-message round trips, and the whole span since the request was
  // parsed. A rejected turn (gate, dead credential, unsupported family,
  // saturated capacity) returns above and is not measured here.
  logger.info("chat preamble", {
    credentialMode,
    providerId: chosen.providerId,
    phaseAMs,
    phaseBMs,
    claimTurnMs,
    persistUserMessageMs,
    preambleMs: Date.now() - turnStart,
  });

  // Generation abort is DECOUPLED from the request connection: a client
  // disconnect must NOT cancel generation (that was the data-loss bug). Only an
  // explicit stop (POST …/chat/sessions/:id/stop) aborts this controller.
  const generation = new AbortController();
  registerStopController(streamId, generation);

  // Tee the engine stream into a resumable producer (decoupled from the client)
  // and persist the assistant turn when it finalizes — both run to completion
  // regardless of the client; the persist task is tracked for graceful shutdown.
  // See finalize-stream.ts for the disconnect-survival guarantee + its test.
  const finalize = (engineResponse: Response): Promise<Response> =>
    finalizeChatStream({
      engineResponse,
      streamId,
      precedingMessageId: userMessageId ?? null,
      onAssistant:
        sessionId && userMessageId
          ? (assistant, preceding) => persistAssistantMessage(sessionId, assistant, preceding)
          : undefined,
      onSettled: async () => {
        unregisterStopController(streamId);
        // Before the client's stream closes, so its next turn finds the conversation free.
        // Swallowed: a failed DB update must not surface as an unhandled rejection.
        if (sessionId) await clearActiveStream(sessionId, streamId).catch(() => {});
      },
    });

  // Teardown for the failure path below: if the engine throws BEFORE `finalize`
  // takes over (which owns teardown via `onSettled`), we must still release the
  // stop controller, the concurrency slot, and clear the in-flight marker (else
  // the session is stuck "generating" with a dead stream id). `release()` is
  // idempotent, so folding it in here makes the slot leak-proof structurally
  // instead of depending on every engine failure path remembering to release.
  const failCleanup = async () => {
    unregisterStopController(streamId);
    slot.release();
    if (sessionId) await clearActiveStream(sessionId, streamId).catch(() => {});
  };

  // Drive the turn. OAuth bindings keep the real access token in memory;
  // API-key bindings carry only the inert proxy key and mint a fresh loopback
  // bearer for every llm-proxy call.
  //
  // The engine opens its OWN platform MCP connection (`/api/mcp/o/:org`), and
  // run_and_wait hits platform run routes with these headers. It must NEVER
  // receive the caller's raw cookie/Authorization (reusable far beyond chat).
  // Hand it a short-lived, process-local bearer carrying EXACTLY the turn's
  // permissions (the union over the turn's spaces, narrowed by `turnPermissions`) and
  // NOT first-party-loopback (can't be replayed against the inference proxy).
  // It is server-minted, so the integration tools reach the credential proxy
  // with it, exactly as any MCP client's bearer does.
  const mcpToken = mintMcpLoopbackToken(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      orgId,
      orgRole,
      permissions,
      // The re-entered request carries no header, so without this the hop would
      // answer with the caller's real authority while a preview is on screen.
      viewAs: persona,
      // What `resources/read` serves without `skills:*`: the definitions this prompt injected.
      injectedSkills,
      // The spaces the bearer reaches: the turn's (a limited conversation's origin alone).
      spaceIds: spaces.map((space) => space.id),
      restricted: scope.restricted,
      // The conversation issuing its requests: a run it launches may take its own files.
      chatSessionId,
    },
    { ttlMs: ENGINE_LOOPBACK_TTL_MS },
  );
  const mcpHeaders: Record<string, string> = {
    Authorization: `Bearer ${mcpToken}`,
    "x-org-id": orgId,
  };
  const mcpUrl = platformMcpUrl(origin, orgId);
  try {
    const response = await finalize(
      runEngine({
        slot,
        modelBinding,
        presetId: chosen.id,
        // The same string the picker shows (`model-select.tsx` renders
        // `label ?? modelId`), so the transcript and the composer never
        // disagree about what the model is called.
        modelLabel: chosen.label ?? chosen.modelId,
        orgId,
        userId: user.id,
        chatSessionId,
        requestId,
        messages,
        ...(uploadResolutions ? { leadingChunks: [uploadResolutions] } : {}),
        readAttachment: (uri, options) =>
          deps.readChatAttachment({
            orgId,
            userId: user.id,
            uri,
            spaces: attachmentSpaces,
            personalSpaceId,
            chatSessionId,
            beforeResolve: organization.touch,
            ...options,
          }),
        system,
        generation: generationSettings,
        platformMcp: {
          url: mcpUrl,
          headers: mcpHeaders,
          organization,
          // Same in-process seam the preamble reads through: the engine's
          // MCP hops re-enter the platform app directly instead of opening real
          // loopback sockets back into this process. Auth and RBAC still run on
          // every hop, so the scoped bearer above is exactly as load-bearing.
          fetch: platformFetch,
          surfaceKey: platformMcpSurfaceKey(mcpUrl, permissions, spaces),
          // A persisted conversation pins the skills the assistant loads, out of what this
          // prompt left of the budget; an ephemeral turn's loads are plain reads.
          ...(chatSessionId
            ? {
                skillLoad: turnSkillLoad({
                  uris: skillUris,
                  injected: Object.keys(injectedSkills.skills),
                  budgetLeft: skillBudgetLeft,
                  pin: (packageId) => pinAssistantSkill(chatSessionId, streamId, packageId),
                }),
              }
            : {}),
          // The launch body's `modelId`, judged by the inline route like any explicit
          // one (it exists, the caller pays, admission). Never a tool argument.
          ...(body.inline_runs_use_chat_model === true
            ? {
                inlineRunModel: {
                  modelId: chosen.id,
                  ...(body.generation && { generation: body.generation }),
                },
              }
            : {}),
        },
        // Decoupled from the request connection (see `generation` above).
        abortSignal: generation.signal,
        onError: (error) => logAndMarkStreamError(error, requestId),
        // Fire-and-forget metering — never blocks or fails the turn.
        recordUsage: (record) => {
          // Only a subscription turn meters inline, on the subscription its engine spends.
          const credentialId =
            subscription.subscription && "model" in subscription
              ? subscription.model.credentialId
              : null;
          recordTurnUsage({ ...record, credentialId }, deps.recordChatUsage);
        },
      }),
    );
    // Time to the Response object: from the parsed request to the resumable
    // stream being wired up and handed back. `preambleMs` above stops before
    // the engine is invoked; this includes the engine's synchronous setup and
    // `finalizeChatStream`.
    logger.info("chat turn response", {
      credentialMode,
      providerId: chosen.providerId,
      toResponseMs: Date.now() - turnStart,
    });
    return response;
  } catch (err) {
    await failCleanup();
    throw err;
  }
}
