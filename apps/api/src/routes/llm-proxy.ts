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
 * Additional families (`openai-responses`, `google-generative-ai`, …)
 * are mechanical — drop a new adapter + route and wire it here. The
 * spec explicitly resists premature abstraction so each route keeps its
 * own adapter binding instead of sharing a single dispatch table.
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
 *     a call to a specific `runs` row so cost rolls up per-run.
 *   - Audit log on every call (authMethod, principalId, preset, status,
 *     duration).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { invalidRequest } from "../lib/errors.ts";
import { assertBearerOnly } from "../lib/bearer-only.ts";
import { recordLlmLatency } from "../observability/index.ts";
import {
  proxyLlmCall,
  LlmProxyModelApiMismatchError,
  LlmProxyUnsupportedModelError,
} from "../services/llm-proxy/core.ts";
import { openaiCompletionsAdapter } from "../services/llm-proxy/openai.ts";
import { anthropicMessagesAdapter } from "../services/llm-proxy/anthropic.ts";
import { mistralConversationsAdapter } from "../services/llm-proxy/mistral.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import { getLlmProxyLimits, type LlmProxyLimits } from "../services/proxy-limits.ts";
import type { AppEnv } from "../types/index.ts";

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

  return router;
}

async function handleProxy(
  c: Context<AppEnv>,
  adapter: LlmProxyAdapter,
  upstreamPath: string,
  limits: LlmProxyLimits,
): Promise<Response> {
  const authMethod = c.get("authMethod");
  assertBearerOnly(authMethod, "LLM proxy");

  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");
  const userId = c.get("user").id;
  const principal: LlmProxyPrincipal = apiKeyId
    ? { kind: "api_key", apiKeyId, orgId, userId }
    : { kind: "jwt_user", userId, orgId };

  const runIdHeader = c.req.header("X-Run-Id");
  const runId = runIdHeader && runIdHeader.length > 0 ? runIdHeader : null;

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
      upstreamPath,
      incomingHeaders: c.req.raw.headers,
      rawBody,
      maxRequestBytes: limits.max_request_bytes,
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

    recordLlmLatency(durationMs, {
      api_shape: adapter.apiShape,
      status: response.status,
      outcome: response.ok ? "success" : "error",
    });

    return response;
  } catch (err) {
    recordLlmLatency(Date.now() - started, {
      api_shape: adapter.apiShape,
      outcome: "error",
    });
    if (err instanceof LlmProxyUnsupportedModelError) {
      throw invalidRequest(err.message);
    }
    if (err instanceof LlmProxyModelApiMismatchError) {
      throw invalidRequest(err.message, "model");
    }
    throw err;
  }
}
