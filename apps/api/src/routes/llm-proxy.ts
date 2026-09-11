// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/llm-proxy/<api>/*` — server-side LLM model injection for
 * remote-backed AFPS runs.
 *
 * Three protocol families ship today. Each shape's path mirrors the upstream
 * SDK's own convention, so a stored `baseUrl` produces the same final URL
 * whether pi-ai calls the upstream directly or via this proxy:
 *
 *   - `openai-completions`   → `/v1/chat/completions`
 *   - `anthropic-messages`   → `/v1/messages`
 *   - `mistral-conversations` → `/v1/chat/completions`
 *
 * Those paths are NOT written here. They come from `LLM_PROXY_ROUTES`
 * (`@appstrate/runner-pi`), the one table that also builds the base URL chat
 * and the CLI point their vendor clients at — the three used to spell the
 * convention out separately and drift silently. Adding a family is a table row
 * plus an adapter in the `adapters` map below; the mount loop needs no edit.
 *
 * This header used to claim the opposite — that "the spec explicitly resists
 * premature abstraction so each route keeps its own adapter binding instead of
 * sharing a single dispatch table" — for a while AFTER the dispatch table
 * landed. The phrase appears nowhere in `docs/`: it attributed to the spec a
 * constraint the spec does not carry, which is worse than no rationale, because
 * the next contributor reads it as one and hand-mounts a fourth route beside
 * the loop.
 *
 * Subscription shapes are NOT served here:
 *   - OAuth-subscription models (`claude-code`, `codex`) never flow through this
 *     proxy. Chat drives them via the in-process Pi engine
 *     (packages/module-chat/src/pi-chat/engine.ts); runs get the token via the
 *     sidecar's verbatim bearer-swap. In both paths `pi-ai` emits the provider's
 *     own subscription request shape — the platform forges nothing. See
 *     docs/architecture/SUBSCRIPTION_COMPLIANCE.md.
 *   - The generic gateway (`proxyLlmCall`) therefore refuses an
 *     OAuth-subscription model with `LlmProxyUnsupportedSubscriptionError`.
 *     Connect an API-key provider to use this proxy.
 *
 * Security:
 *   - Bearer auth only — API keys with `llm-proxy:call` (headless) OR
 *     OIDC-issued JWTs (interactive CLI `oauth2-instance`, dashboard
 *     `oauth2-dashboard`). Cookie sessions refused.
 *   - Per-call rate limit keyed on principal (`auth` category).
 *   - Per-call accounting in `llm_usage` (source='proxy') — input/output/
 *     cache tokens + derived cost_usd. Upstream errors don't mint usage rows.
 *   - Body size capped via `LLM_PROXY_LIMITS.max_request_bytes`
 *     (default 10 MiB).
 *
 * Observability:
 *   - `X-Run-Id` request header (optional; Phase 4 populates it) pins
 *     a call to a specific `runs` row so cost rolls up per-run. The id is
 *     validated against the principal (org + space + actor for JWT
 *     users) before the upstream call — see {@link assertRunAttributable}.
 *   - Audit log on every call (authMethod, principalId, preset, status,
 *     duration).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { invalidRequest, forbidden, notFound } from "../lib/errors.ts";
import { assertBearerOnly } from "../lib/bearer-only.ts";
import { LLM_PROXY_ROUTES, llmProxyUrlPath, type ProxiedApiShape } from "@appstrate/runner-pi";
import { getRunAttribution } from "../services/state/runs.ts";
import { enforceSystemProxyAdmission } from "../services/system-proxy-admission.ts";
import { recordLlmLatency } from "@appstrate/core/telemetry";
import {
  proxyLlmCall,
  LlmProxyModelApiMismatchError,
  LlmProxyUnsupportedModelError,
  LlmProxyUnsupportedSubscriptionError,
} from "../services/llm-proxy/core.ts";
import { openaiCompletionsAdapter } from "../services/llm-proxy/openai.ts";
import { anthropicMessagesAdapter } from "../services/llm-proxy/anthropic.ts";
import { mistralConversationsAdapter } from "../services/llm-proxy/mistral.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import { buildLlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import { getLlmProxyLimits, type LlmProxyLimits } from "../services/proxy-limits.ts";
import type { AppEnv } from "../types/index.ts";
import { ACTIVE_RUN_STATUSES } from "@appstrate/db/schema";

export function createLlmProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = getLlmProxyLimits();

  // Protocol family → adapter. The PATHS are not spelled out here any more:
  // `LLM_PROXY_ROUTES` (`@appstrate/runner-pi`) owns the convention, because
  // the chat engine and the CLI have to build a base URL that agrees with it
  // and used to do so by hand-copying these strings. Only the adapter — the
  // request/response translation, which is genuinely this package's business —
  // is bound here.
  const adapters: Record<ProxiedApiShape, LlmProxyAdapter> = {
    "openai-completions": openaiCompletionsAdapter,
    "anthropic-messages": anthropicMessagesAdapter,
    "mistral-conversations": mistralConversationsAdapter,
  };

  for (const apiShape of Object.keys(adapters) as ProxiedApiShape[]) {
    const adapter = adapters[apiShape];
    // `sdkPath` doubles as the upstream path — see the note on the table.
    const upstreamPath = LLM_PROXY_ROUTES[apiShape].sdkPath;
    router.post(
      llmProxyUrlPath(apiShape),
      rateLimit(limits.rate_per_min),
      requirePermission("llm-proxy", "call"),
      async (c) => handleProxy(c, adapter, upstreamPath, limits),
    );
  }

  // No subscription SDK gateway: oauth-subscription chat now runs on the single
  // generic in-process Pi chat engine owned by `@appstrate/module-chat`, which
  // resolves the real token + baseUrl through `ctx.services` and drives Pi
  // inline — there is no per-provider credential-injection proxy to mount here.
  return router;
}

/**
 * Validate a caller-supplied `X-Run-Id` against the calling principal
 * (CRIT-07). The header pins the call's `llm_usage` row to a run, and
 * `computeRunSpend` rolls those rows up into `runs.cost` — so an unvalidated
 * id would let any principal holding `llm-proxy:call` inflate the cost of
 * any run whose id it knows, including runs of other tenants.
 *
 * Checks, in order:
 *   1. The run exists inside the principal's org (`getRunAttribution` is
 *      org-scoped) — unknown and cross-org ids both map to the same 404 so
 *      a foreign tenant's run id cannot be probed for existence.
 *   2. The run belongs to the same space as the auth context, when the
 *      context carries one (always true for API keys — they are space-bound;
 *      JWT strategies may resolve without a space, in which case the
 *      org boundary plus the actor check below is the enforced scope).
 *   3. For an actor-bound identity (`jwt_user`), the run must belong to that
 *      same user — a JWT user cannot attribute spend to another actor's run.
 *      API-key principals are space-scoped infrastructure identities (the run
 *      may legitimately carry a user/end-user actor or a sibling key), so the
 *      org + space boundary is their enforcement line.
 *   4. The run is still active. A terminal run id must not become a reusable
 *      billing context for arbitrary post-run system-model calls.
 *
 * Because check 3 leaves an API key free to reference any live run of its own
 * space, this validation alone does NOT bound platform-paid spend — it
 * bounds cost *attribution*. Admission is enforced separately, per call, by
 * `enforceSystemProxyAdmission`, which gates every run-context call —
 * platform-supplied or BYOK — regardless of the referenced run's origin.
 */
async function assertRunAttributable(
  c: Context<AppEnv>,
  runId: string,
  principal: LlmProxyPrincipal,
): Promise<NonNullable<Awaited<ReturnType<typeof getRunAttribution>>>> {
  const run = await getRunAttribution(principal.orgId, runId);
  if (!run) {
    throw notFound(`run ${runId} not found`);
  }
  const spaceId = c.get("spaceId");
  if (spaceId && run.spaceId !== spaceId) {
    throw notFound(`run ${runId} not found`);
  }
  if (principal.kind === "jwt_user" && run.userId !== principal.userId) {
    throw forbidden("X-Run-Id does not reference a run owned by the calling user");
  }
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
    throw invalidRequest(`run ${runId} is no longer active`);
  }
  return run;
}

async function handleProxy(
  c: Context<AppEnv>,
  adapter: LlmProxyAdapter,
  upstreamPath: string,
  limits: LlmProxyLimits,
): Promise<Response> {
  const authMethod = c.get("authMethod");
  assertBearerOnly(authMethod, "LLM proxy", { firstPartyLoopback: c.get("firstPartyLoopback") });

  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");
  const userId = c.get("user").id;
  const principal = buildLlmProxyPrincipal({ apiKeyId, orgId, userId });

  // Chat attribution rides the VALIDATED loopback bearer's claims, surfaced by
  // the auth pipeline as opaque `authExtra` (never a caller-supplied header —
  // that would let any proxy caller stamp spend onto an arbitrary session). The
  // chat-loopback strategy is the only minter of this shape.
  const authExtra = c.get("authExtra");
  const chatSessionId =
    authExtra && typeof authExtra.chatSessionId === "string" ? authExtra.chatSessionId : null;

  const runIdHeader = c.req.header("X-Run-Id");
  const runId = runIdHeader && runIdHeader.length > 0 ? runIdHeader : null;
  // CRIT-07 guard — `X-Run-Id` is caller-supplied and feeds
  // `llm_usage.run_id` → `computeRunSpend` → `runs.cost`. Validate it against
  // the principal BEFORE the upstream call so a caller with `llm-proxy:call`
  // cannot bill LLM cost onto an arbitrary (even cross-tenant) run.
  const runAttribution = runId ? await assertRunAttributable(c, runId, principal) : null;
  if (runAttribution && !runAttribution.packageId) {
    throw invalidRequest(`run ${runAttribution.id} has no agent package attribution`);
  }
  const usageContext = runAttribution
    ? ({
        context: "run",
        packageId: runAttribution.packageId!,
        // ATTRIBUTION DATA, NOT A GATING INPUT. The admission seam reports this
        // onward as the `beforeUsage` `executionPlane` fact (platform-origin →
        // `"platform"`, otherwise `"remote"`) so a metering module can tell
        // platform compute from caller-supplied compute. It must never decide
        // WHETHER the hook fires: this field's previous life as half of an
        // "already admitted at preflight" skip condition was an admission
        // bypass, and the seam now gates every run-context system call.
        runOrigin: runAttribution.runOrigin,
      } as const)
    : c.get("firstPartyLoopback")
      ? ({ context: "chat", sessionId: chatSessionId } as const)
      : null;

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    throw invalidRequest("Request body is empty");
  }
  const rawBody = new Uint8Array(buf);

  const started = Date.now();
  try {
    const response = await proxyLlmCall({
      adapter,
      principal,
      runId,
      chatSessionId,
      upstreamPath,
      incomingHeaders: c.req.raw.headers,
      rawBody,
      maxRequestBytes: limits.max_request_bytes,
      beforeUpstream: (resolved) => enforceSystemProxyAdmission({ orgId, resolved, usageContext }),
    });

    const durationMs = Date.now() - started;
    logger.info("llm-proxy call", {
      requestId: c.get("requestId"),
      authMethod,
      apiKeyId,
      userId,
      orgId,
      apiShape: adapter.apiShape,
      runId,
      status: response.status,
      durationMs,
    });

    // 4xx/5xx upstream replies are tagged `error.type` by the recorder
    // (status-code string, OTel semconv); 2xx points carry no error attribute.
    recordLlmLatency(durationMs, {
      api_shape: adapter.apiShape,
      status: response.status,
    });

    return response;
  } catch (err) {
    // Client-validation rejections are thrown before any upstream call, so
    // they must NOT pollute the upstream-latency histogram. Record latency
    // only for errors from an actual upstream attempt.
    if (err instanceof LlmProxyUnsupportedModelError) {
      throw invalidRequest(err.message);
    }
    if (err instanceof LlmProxyUnsupportedSubscriptionError) {
      // The backing provider id is masked in the caller-facing message
      // (alias masking) — log it server-side for diagnosability.
      logger.warn("llm-proxy: rejected OAuth-subscription model", {
        providerId: err.providerId,
        orgId,
      });
      throw invalidRequest(err.message, "model");
    }
    if (err instanceof LlmProxyModelApiMismatchError) {
      // Same: for an aliased preset the message hides `actual` — keep the
      // full mismatch detail in server logs.
      logger.warn("llm-proxy: model/endpoint apiShape mismatch", {
        presetId: err.presetId,
        expected: err.expected,
        actual: err.actual,
        orgId,
      });
      throw invalidRequest(err.message, "model");
    }
    // No `status`: the upstream attempt produced no response, which the
    // recorder tags as `error.type: "_OTHER"` (semconv fallback value).
    recordLlmLatency(Date.now() - started, {
      api_shape: adapter.apiShape,
    });
    throw err;
  }
}
