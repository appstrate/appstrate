// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/llm-proxy/<api>/*` — server-side LLM model injection for
 * remote-backed AFPS runs (docs/specs/REMOTE_CLI_EXECUTION_SPEC.md §Phase 3).
 *
 * Two concrete protocol families ship today:
 *
 *   - `openai-completions` → `/v1/chat/completions`
 *   - `anthropic-messages` → `/v1/messages`
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
import { forbidden, invalidRequest } from "../lib/errors.ts";
import {
  proxyLlmCall,
  LlmProxyModelApiMismatchError,
  LlmProxyUnsupportedModelError,
} from "../services/llm-proxy/core.ts";
import { openaiCompletionsAdapter } from "../services/llm-proxy/openai.ts";
import { anthropicMessagesAdapter } from "../services/llm-proxy/anthropic.ts";
import type { LlmProxyAdapter, LlmProxyPrincipal } from "../services/llm-proxy/types.ts";
import type { AppEnv } from "../types/index.ts";

/** Accepted auth methods — mirrors credential-proxy. */
const ACCEPTED_AUTH_METHODS: ReadonlySet<string> = new Set([
  "api_key",
  "oauth2-instance",
  "oauth2-dashboard",
]);

interface LlmProxyLimits {
  rate_per_min: number;
  max_request_bytes: number;
}

function parseLimits(): LlmProxyLimits {
  const defaults: LlmProxyLimits = {
    rate_per_min: 60,
    max_request_bytes: 10 * 1024 * 1024,
  };
  const raw = process.env.LLM_PROXY_LIMITS;
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<LlmProxyLimits>;
    return {
      rate_per_min: parsed.rate_per_min ?? defaults.rate_per_min,
      max_request_bytes: parsed.max_request_bytes ?? defaults.max_request_bytes,
    };
  } catch (err) {
    logger.warn("LLM_PROXY_LIMITS is not valid JSON — using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
    return defaults;
  }
}

export function createLlmProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = parseLimits();

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
  if (!ACCEPTED_AUTH_METHODS.has(authMethod)) {
    throw forbidden(
      `LLM proxy does not accept auth method "${authMethod}" (cookie sessions and unknown strategies rejected)`,
    );
  }

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
    const { response } = await proxyLlmCall({
      adapter,
      principal,
      runId,
      upstreamPath,
      incomingHeaders: c.req.raw.headers,
      rawBody,
      maxRequestBytes: limits.max_request_bytes,
    });

    logger.info("llm-proxy call", {
      requestId: c.get("requestId"),
      authMethod,
      apiKeyId,
      userId,
      orgId,
      api: adapter.api,
      runId,
      status: response.status,
      durationMs: Date.now() - started,
    });

    return response;
  } catch (err) {
    if (err instanceof LlmProxyUnsupportedModelError) {
      throw invalidRequest(err.message);
    }
    if (err instanceof LlmProxyModelApiMismatchError) {
      throw invalidRequest(err.message, "model");
    }
    throw err;
  }
}
