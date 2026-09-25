// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/llm-proxy/<api>/*` — server-side LLM model injection for
 * remote-backed AFPS runs.
 *
 * Four protocol families ship today. Each shape's path mirrors the upstream
 * SDK's own convention, so a stored `baseUrl` produces the same final URL
 * whether pi-ai calls the upstream directly or via this proxy:
 *
 *   - `openai-completions`   → `/v1/chat/completions`
 *   - `openai-responses`     → `/v1/responses`
 *   - `anthropic-messages`   → `/v1/messages`
 *   - `mistral-conversations` → `/v1/chat/completions`
 *
 * Those paths are NOT written here. They come from `LLM_PROXY_ROUTES`
 * (`@appstrate/runner-pi`), the one table that also builds the base URL chat
 * and the CLI point their vendor clients at — the three used to spell the
 * convention out separately and drift silently. Adding a family is a table row
 * plus an adapter in the `adapters` map below; the mount loop needs no edit, and
 * no route is hand-mounted beside it.
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
 * A platform run whose model spends a platform-provided credential reaches the
 * same pipeline at `/internal/llm-proxy/<api>/*` with its run token — see
 * {@link createRunLlmProxyRouter}.
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
import { bodyLimit } from "../middleware/body-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { invalidRequest, forbidden, notFound } from "../lib/errors.ts";
import { assertBearerOnly } from "../lib/bearer-only.ts";
import { LLM_PROXY_ROUTES, llmProxyUrlPath, type ProxiedApiShape } from "@appstrate/runner-pi";
import { getRunAttribution, isMeteredByPlatformProxy } from "../services/state/runs.ts";
import { enforceSystemProxyAdmission } from "../services/system-proxy-admission.ts";
import { recordLlmLatency } from "@appstrate/core/telemetry";
import {
  proxyLlmCall,
  LlmProxyModelApiMismatchError,
  LlmProxyUnsupportedModelError,
  LlmProxyUnsupportedSubscriptionError,
} from "../services/llm-proxy/core.ts";
import { openaiCompletionsAdapter } from "../services/llm-proxy/openai.ts";
import { openaiResponsesAdapter } from "../services/llm-proxy/openai-responses.ts";
import { anthropicMessagesAdapter } from "../services/llm-proxy/anthropic.ts";
import { mistralConversationsAdapter } from "../services/llm-proxy/mistral.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import { buildLlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import { getLlmProxyLimits, type LlmProxyLimits } from "../services/proxy-limits.ts";
import type { AppEnv } from "../types/index.ts";
import { ACTIVE_RUN_STATUSES } from "@appstrate/db/run-status";
import { verifyRunToken } from "../lib/verify-run-token.ts";

// Protocol family → adapter; the paths come from `LLM_PROXY_ROUTES`.
const ADAPTERS: Record<ProxiedApiShape, LlmProxyAdapter> = {
  "openai-completions": openaiCompletionsAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "mistral-conversations": mistralConversationsAdapter,
};

const PROXIED_API_SHAPES = Object.keys(ADAPTERS) as ProxiedApiShape[];

export function createLlmProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = getLlmProxyLimits();

  for (const apiShape of PROXIED_API_SHAPES) {
    // Past `llm-proxy:call` the RUN named by `X-Run-Id`
    // decides — a jwt principal may only bill a run it launched
    // (`assertRunAttributable`).
    router.post(
      llmProxyUrlPath(apiShape),
      rateLimit(limits.rate_per_min),
      requirePermission("llm-proxy", "call"),
      async (c) => handleProxy(c, apiShape, limits),
    );
  }

  // No subscription SDK gateway: oauth-subscription chat now runs on the single
  // generic in-process Pi chat engine owned by `@appstrate/module-chat`, which
  // resolves the real token + baseUrl through `ctx.services` and drives Pi
  // inline — there is no per-provider credential-injection proxy to mount here.
  return router;
}

/**
 * A platform run's own inference, at `RUN_LLM_PROXY_MOUNT`, called by its
 * sidecar with the run token. Serves the run's pinned model whatever the body
 * names. Rate-limited by the `/internal/*` limiter; the body cap below is the
 * only one (`index.ts` exempts the mount from the global cap).
 */
export function createRunLlmProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = getLlmProxyLimits();
  router.use("/*", bodyLimit(limits.max_request_bytes));

  for (const apiShape of PROXIED_API_SHAPES) {
    router.post(llmProxyUrlPath(apiShape), async (c) => {
      const { runId, run } = await verifyRunToken(c);
      if (!isMeteredByPlatformProxy(run)) {
        throw forbidden("This run's model is not served by the platform LLM proxy");
      }
      const orgId = run.orgId;
      return proxyAndLog(c, apiShape, limits, {
        principal: { kind: "run", orgId },
        runId,
        chatSessionId: null,
        presetId: run.modelId,
        beforeUpstream: (resolved) =>
          enforceSystemProxyAdmission({
            orgId,
            resolved,
            usageContext: { context: "run_inference" },
          }),
      });
    });
  }
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
  apiShape: ProxiedApiShape,
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

  return proxyAndLog(c, apiShape, limits, {
    principal,
    runId,
    chatSessionId,
    beforeUpstream: (resolved) => enforceSystemProxyAdmission({ orgId, resolved, usageContext }),
  });
}

/** The caller-specific half of a proxy call; the rest is shared by both entries. */
type ProxyCaller = Pick<
  Parameters<typeof proxyLlmCall>[0],
  "principal" | "runId" | "chatSessionId" | "presetId" | "beforeUpstream"
>;

/**
 * Read the body, run the shared pipeline, log and time the call, and map the
 * proxy's client-validation refusals onto 400s.
 */
async function proxyAndLog(
  c: Context<AppEnv>,
  apiShape: ProxiedApiShape,
  limits: LlmProxyLimits,
  caller: ProxyCaller,
): Promise<Response> {
  const adapter = ADAPTERS[apiShape];
  const orgId = caller.principal.orgId;
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    throw invalidRequest("Request body is empty");
  }
  const rawBody = new Uint8Array(buf);

  const started = Date.now();
  try {
    const response = await proxyLlmCall({
      ...caller,
      adapter,
      requestId: c.get("requestId"),
      // `sdkPath` doubles as the upstream path — see the note on the table.
      upstreamPath: LLM_PROXY_ROUTES[apiShape].sdkPath,
      incomingHeaders: c.req.raw.headers,
      rawBody,
      maxRequestBytes: limits.max_request_bytes,
    });

    const durationMs = Date.now() - started;
    logger.info("llm-proxy call", {
      requestId: c.get("requestId"),
      authMethod: caller.principal.kind === "run" ? "run_token" : c.get("authMethod"),
      apiKeyId: caller.principal.kind === "api_key" ? caller.principal.apiKeyId : undefined,
      userId: caller.principal.kind === "run" ? undefined : caller.principal.userId,
      orgId,
      apiShape: adapter.apiShape,
      runId: caller.runId,
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
