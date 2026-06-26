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
 *   - `chatEngine` looks up a subscription chat engine (e.g. Claude) by provider
 *     id — platform-injected (`ctx.services.chatHandlerForProvider` reads the
 *     model-provider registry, an apps/api concern, and returns only the
 *     module-contributed `chatHandler`). This module never imports
 *     that registry or any vendor SDK; only the shared `ChatEngineInput` type
 *     crosses the boundary.
 */

import type { MiddlewareHandler } from "hono";
import type { ModuleInitContext } from "@appstrate/core/module";
import type { ChatEngineInput } from "@appstrate/core/subscription-engines";

/**
 * A subscription chat engine surfaced to the chat: the provider it serves + its
 * turn handler. Assembled from the provider id + the `chatHandler` the platform
 * resolves — only providers that carry a `chatHandler` (Claude) become a
 * `ChatEngine`; codex (no chat surface) resolves to `undefined`.
 */
export interface ChatEngine {
  providerId: string;
  handler: (input: ChatEngineInput) => Response;
}

export interface ChatPlatformDeps {
  /**
   * Dispatch a request into the platform. In-process via the wired platform app
   * when available, else a loopback `fetch` (OSS/tests). The auth pipeline runs
   * either way.
   */
  dispatch(request: Request): Promise<Response>;
  /** Platform per-route rate limiter factory. */
  rateLimit(maxPerMinute: number): MiddlewareHandler;
  /** Subscription chat engine for a provider id, or `undefined` (→ ai-sdk path). */
  chatEngine(providerId: string): ChatEngine | undefined;
}

/**
 * Build the immutable deps object from the module init context. Called once in
 * `chatModule.init(ctx)`.
 *
 * `ctx` is optional: when the module's router is built WITHOUT `init()` having
 * run (the test harness mounts module routers directly, and OSS standalone
 * wiring may skip init), the deps degrade to the safe baseline — loopback
 * `fetch` dispatch, a pass-through rate limiter, and no subscription chat engine
 * — the same posture this module had before deps were threaded explicitly.
 */
/** Pass-through limiter used when no init context supplied a real one. */
const passThroughRateLimit: MiddlewareHandler = (_c, next) => next();

export function buildChatPlatformDeps(ctx?: ModuleInitContext): ChatPlatformDeps {
  const inProcess = ctx?.services.inProcess ?? null;
  return {
    dispatch: (request) => (inProcess ? inProcess.dispatch(request) : fetch(request)),
    rateLimit: (maxPerMinute) =>
      ctx ? ctx.services.http.rateLimit(maxPerMinute) : passThroughRateLimit,
    chatEngine: (providerId) => {
      const handler = ctx?.services.chatHandlerForProvider(providerId);
      // Only an engine with a chat surface (a contributed chatHandler) is usable
      // by the chat — codex resolves with no chatHandler → undefined → ai-sdk
      // path / disabled.
      return handler ? { providerId, handler } : undefined;
    },
  };
}
