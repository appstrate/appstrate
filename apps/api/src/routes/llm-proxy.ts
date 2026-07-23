// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/llm-proxy/<api>/*` — server-side LLM model injection for
 * remote-backed AFPS runs (docs/specs/REMOTE_CLI_EXECUTION_SPEC.md §Phase 3).
 *
 * Three protocol families ship today (each `urlPath` mirrors the
 * upstream SDK's own path convention so a stored `baseUrl` produces
 * the same final URL whether pi-ai calls the upstream directly or via
 * this proxy):
 *
 *   - `openai-completions`   → `/v1/chat/completions`
 *   - `anthropic-messages`   → `/v1/messages`
 *   - `mistral-conversations` → `/v1/chat/completions`
 *
 * Additional API-key families (`openai-responses`, `google-generative-ai`, …)
 * are mechanical — drop a new adapter + route and wire it here. The
 * spec explicitly resists premature abstraction so each route keeps its
 * own adapter binding instead of sharing a single dispatch table.
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
 *     validated against the principal (org + application + actor for JWT
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

  // Protocol family → (adapter, upstream path). Keep one entry per API;
  // the route surface stays concrete per the spec.
  const routes: Array<{
    urlPath: string;
    upstreamPath: string;
    adapter: LlmProxyAdapter;
  }> = [
    // `upstreamPath` mirrors each SDK's own path convention so a stored
    // `baseUrl` produces the same final URL whether pi-ai calls the
    // upstream directly (platform runner) or via this proxy (CLI).
    //   - OpenAI SDK appends `/chat/completions` → baseUrl carries `/v1`
    //     (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`).
    //   - Anthropic SDK appends `/v1/messages` → baseUrl is the bare host
    //     (`https://api.anthropic.com`).
    {
      urlPath: "/openai-completions/v1/chat/completions",
      upstreamPath: "/chat/completions",
      adapter: openaiCompletionsAdapter,
    },
    {
      urlPath: "/anthropic-messages/v1/messages",
      upstreamPath: "/v1/messages",
      adapter: anthropicMessagesAdapter,
    },
    // Mistral SDK (`@mistralai/mistralai` `chat.stream`) appends
    // `/v1/chat/completions` to its `serverURL` — same convention as
    // Anthropic, NOT OpenAI.
    {
      urlPath: "/mistral-conversations/v1/chat/completions",
      upstreamPath: "/v1/chat/completions",
      adapter: mistralConversationsAdapter,
    },
  ];

  for (const entry of routes) {
    router.post(
      entry.urlPath,
      rateLimit(limits.rate_per_min),
      requirePermission("llm-proxy", "call"),
      async (c) => handleProxy(c, entry.adapter, entry.upstreamPath, limits),
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
 * `computeRunCost` rolls those rows up into `runs.cost` — so an unvalidated
 * id would let any principal holding `llm-proxy:call` inflate the cost of
 * any run whose id it knows, including runs of other tenants.
 *
 * Checks, in order:
 *   1. The run exists inside the principal's org (`getRunAttribution` is
 *      org-scoped) — unknown and cross-org ids both map to the same 404 so
 *      a foreign tenant's run id cannot be probed for existence.
 *   2. The run belongs to the same application as the auth context, when the
 *      context carries one (always true for API keys — they are app-bound;
 *      JWT strategies may resolve without an application, in which case the
 *      org boundary plus the actor check below is the enforced scope).
 *   3. For an actor-bound identity (`jwt_user`), the run must belong to that
 *      same user — a JWT user cannot attribute spend to another actor's run.
 *      API-key principals are app-scoped infrastructure identities (the run
 *      may legitimately carry a user/end-user actor or a sibling key), so the
 *      org + application boundary is their enforcement line.
 *   4. The run is still active. A terminal run id must not become a reusable
 *      billing context for arbitrary post-run system-model calls.
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
  const applicationId = c.get("applicationId");
  if (applicationId && run.applicationId !== applicationId) {
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
  // `llm_usage.run_id` → `computeRunCost` → `runs.cost`. Validate it against
  // the principal BEFORE the upstream call so a caller with `llm-proxy:call`
  // cannot bill LLM cost onto an arbitrary (even cross-tenant) run.
  const runAttribution = runId ? await assertRunAttributable(c, runId, principal) : null;
  if (runAttribution && !runAttribution.packageId) {
    throw invalidRequest(`run ${runAttribution.id} has no agent package attribution`);
  }
  const usageContext = runAttribution
    ? ({ context: "run", packageId: runAttribution.packageId! } as const)
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
      beforeSystemUpstream: (resolved) =>
        enforceSystemProxyAdmission({ orgId, resolved, usageContext }),
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
