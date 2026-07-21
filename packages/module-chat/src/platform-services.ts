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
 *     used in OSS/test wiring where `ctx.services.inProcess` is absent — lives
 *     INSIDE this object, so callers never branch on it.
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
import type { ModuleInitContext, UsageRejection } from "@appstrate/core/module";
import type { ChatUsageRecord, SubscriptionChatResolution } from "@appstrate/core/chat-contract";

export interface ChatPlatformDeps {
  /**
   * Dispatch a request into the platform. In-process via the wired platform app
   * when available, else a loopback `fetch` (OSS/tests). The auth pipeline runs
   * either way.
   */
  dispatch(request: Request): Promise<Response>;
  /** Platform per-route rate limiter factory. */
  rateLimit(maxPerMinute: number): MiddlewareHandler;
  /**
   * Resolve the chosen model row (`presetId`) for a chat turn: an API-key /
   * unknown provider yields `{ subscription: false }` (ai-sdk path); an oauth2
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
   * Admission gate for a non-subscription (built-in / API-key) turn. The
   * platform decides whether the chosen preset is system-provided and, if so,
   * dispatches the `beforeUsage` hook; an org's own model is never gated.
   * Returns a {@link UsageRejection} to block the turn (surfaced as an RFC 9457
   * problem response with the hook's status — 402 flows through), or null to
   * allow.
   */
  checkUsageAllowed(args: {
    orgId: string;
    presetId: string;
    sessionId: string | null;
  }): Promise<UsageRejection | null>;
}

/**
 * Build the immutable deps object from the module init context. Called once in
 * `chatModule.init(ctx)`.
 *
 * `ctx` is optional: when the module's router is built WITHOUT `init()` having
 * run (the test harness mounts module routers directly, and OSS standalone
 * wiring may skip init), the deps degrade to the safe baseline — loopback
 * `fetch` dispatch, a pass-through rate limiter, and no subscription support
 * (every provider falls through to the ai-sdk path).
 */
/** Pass-through limiter used when no init context supplied a real one. */
const passThroughRateLimit: MiddlewareHandler = (_c, next) => next();

export function buildChatPlatformDeps(ctx?: ModuleInitContext): ChatPlatformDeps {
  const inProcess = ctx?.services.inProcess ?? null;
  return {
    dispatch: (request) => (inProcess ? inProcess.dispatch(request) : fetch(request)),
    rateLimit: (maxPerMinute) =>
      ctx ? ctx.services.http.rateLimit(maxPerMinute) : passThroughRateLimit,
    resolveSubscriptionChatModel: (orgId, presetId) =>
      ctx
        ? ctx.services.resolveSubscriptionChatModel(orgId, presetId)
        : // No init context (test harness / OSS standalone) → no subscription
          // resolution surface; treat every model as a non-subscription (ai-sdk)
          // provider, the same safe baseline this module had before.
          Promise.resolve({ subscription: false }),
    recordChatUsage: (record) => (ctx ? ctx.services.recordChatUsage(record) : Promise.resolve()),
    // No init context (test harness / OSS standalone) → no admission gate wired;
    // allow the turn (null), the same safe baseline as before this seam existed.
    checkUsageAllowed: (args) =>
      ctx ? ctx.services.checkUsageAllowed(args) : Promise.resolve(null),
  };
}
