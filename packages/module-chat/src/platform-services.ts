// SPDX-License-Identifier: Apache-2.0

/**
 * Platform capabilities the chat module depends on, captured ONCE at module
 * init from `ctx.services` into an immutable {@link ChatPlatformDeps} object and
 * threaded explicitly into the router, the stream handler, and the model
 * helpers. No module-level mutable globals: there used to be a handful of
 * `let xService = null` slots with `setX` setters, which leaked state across
 * tests/inits; the deps object replaces them.
 *
 *   - `dispatch` re-enters the fully-wired platform Hono app IN-PROCESS (auth +
 *     RBAC still run on the dispatched Request). The loopback `fetch` fallback —
 *     reachable only from the test harness, which builds deps without an init
 *     context — lives INSIDE this object, so callers never branch on it.
 *   - `rateLimit` is the platform's authenticated per-route limiter.
 *   - `resolveSubscriptionChatModel` resolves the chosen model row to an
 *     oauth-subscription binding + a fresh access token (or a reconnect signal),
 *     so the module's generic in-process Pi chat engine can drive ANY
 *     subscription provider without importing the provider module, the
 *     model-provider registry, or any vendor SDK. `recordChatUsage` persists one
 *     metered `llm_usage` row for a turn. Both are first-party core contracts
 *     (`@appstrate/core/chat-contract`), so they cross through `ctx.services`,
 *     never a module-to-module import.
 */

import type { MiddlewareHandler } from "hono";
import type { db } from "@appstrate/db/client";
import type { ModuleInitContext, UsageRejection } from "@appstrate/core/module";

/** The chat module's open DB transaction handle (Drizzle tx). */
type ChatDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
import type {
  ChatAttachmentRequest,
  ChatUsageRecord,
  ResolvedChatAttachment,
  SubscriptionChatResolution,
} from "@appstrate/core/chat-contract";

export interface ChatPlatformDeps {
  /**
   * Dispatch a request into the platform. In-process via the wired platform app
   * when available, else a loopback `fetch` (test harness only). The auth
   * pipeline runs either way.
   */
  dispatch(request: Request): Promise<Response>;
  /** Platform per-route rate limiter factory. */
  rateLimit(maxPerMinute: number): MiddlewareHandler;
  /**
   * Resolve the chosen model row (`presetId`) for a chat turn: an API-key /
   * unknown provider yields `{ subscription: false }` (llm-proxy-bound); an oauth2
   * provider yields the real upstream binding + a fresh access token, or a
   * `needsReconnection` signal when its credential is dead.
   */
  resolveSubscriptionChatModel(
    orgId: string,
    presetId: string,
  ): Promise<SubscriptionChatResolution>;
  /** Persist one metered `llm_usage` row for a completed chat turn. */
  recordChatUsage(record: ChatUsageRecord): Promise<void>;
  /**
   * Resolve a chat composer file attachment (`upload://` or `appfile://`) to a
   * durable `appfile://` URI, materializing the upload into a chat-session-scoped
   * file server-side (the module has no DB access). Throws the platform's
   * quota/cap/not-found errors, which the stream route surfaces to the user.
   */
  resolveChatAttachment(request: ChatAttachmentRequest): Promise<ResolvedChatAttachment>;
  /**
   * Detach-or-delete the files contained by a chat session being deleted. A
   * session file a run still consumes is detached (kept, container NULLed);
   * an unconsumed one is deleted (row + counter + storage). The module has no DB
   * or storage access, so this crosses through `ctx.services`. Called before the
   * session row is removed so the FK cascade cannot destroy the evidence first.
   *
   * Pass the SAME transaction that deletes the `chat_sessions` row so the two
   * commit atomically (closes the materialize-in-the-gap orphan window).
   */
  cleanupSessionFiles(chatSessionId: string, tx?: ChatDbTx): Promise<void>;
  /**
   * Admission gate for a turn — EVERY turn, on either binding (llm-proxy or
   * native OAuth subscription). The
   * platform resolves whether the chosen preset is system-provided and reports
   * it as a fact to the `beforeUsage` hook, which it dispatches unconditionally
   * — a metering module decides what an org-credential turn costs, the platform
   * no longer decides it is free. Returns a {@link UsageRejection} to block the
   * turn (surfaced as an RFC 9457 problem response with the hook's status — 402
   * flows through), or null to allow.
   *
   * `subscription` is the one fact THIS module owns: the turn is served by the
   * in-process Pi engine on the org's own OAuth provider subscription, which
   * makes it `credentialSource: "org"` whatever the preset resolves to. The
   * module reports it rather than deriving the credential source itself — it
   * has no model-registry access by design, so the platform keeps deriving the
   * rest. A subscription turn is NOT exempt: it runs inside the platform's own
   * process, so the platform funds its compute.
   */
  checkUsageAllowed(args: {
    orgId: string;
    presetId: string;
    sessionId: string | null;
    subscription: boolean;
  }): Promise<UsageRejection | null>;
}

/**
 * Build the immutable deps object from the module init context. Called once in
 * `chatModule.init(ctx)`.
 *
 * `ctx` is REQUIRED. It used to be optional, for the apps/api test harness,
 * which mounted this router without ever running `init()`. That fallback
 * silently degraded two post-incident guards — the #968/#971 admission gate
 * (fail-open `null`) and the #965 file teardown (no-op) — so any test that
 * believed it exercised them exercised nothing (issue #989). The harness now
 * runs the real `init()` pipeline, so nothing needs the degraded baseline and
 * a missing context can no longer be mistaken for a working one.
 */
export function buildChatPlatformDeps(ctx: ModuleInitContext): ChatPlatformDeps {
  const inProcess = ctx.services.inProcess ?? null;
  return {
    dispatch: (request) => (inProcess ? inProcess.dispatch(request) : fetch(request)),
    rateLimit: (maxPerMinute) => ctx.services.http.rateLimit(maxPerMinute),
    resolveSubscriptionChatModel: (orgId, presetId) =>
      ctx.services.resolveSubscriptionChatModel(orgId, presetId),
    recordChatUsage: (record) => ctx.services.recordChatUsage(record),
    resolveChatAttachment: (request) => ctx.services.resolveChatAttachment(request),
    cleanupSessionFiles: (chatSessionId, tx) => ctx.services.cleanupSessionFiles(chatSessionId, tx),
    checkUsageAllowed: (args) => ctx.services.checkUsageAllowed(args),
  };
}
