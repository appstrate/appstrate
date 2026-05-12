// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { mountMcp } from "./mcp.ts";
import { BlobStore } from "./blob-store.ts";
import {
  LLM_PROXY_TIMEOUT_MS,
  filterHeaders,
  isBlockedUrl,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyConfig,
  type LlmProxyOauthConfig,
} from "./helpers.ts";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  readPositiveTokenEnv,
} from "./token-budget.ts";
import { OAuthTokenCache, NeedsReconnectionError, type CachedToken } from "./oauth-token-cache.ts";
import {
  buildIdentityHeaders,
  transformBody,
  adaptHeaderForRetry,
  TransformBodyTooLargeError,
} from "./oauth-identity.ts";
import { logger } from "./logger.ts";
import { filterSensitiveHeaders } from "./redact.ts";

export type { SidecarConfig } from "./helpers.ts";

export interface AppDeps {
  config: SidecarConfig;
  fetchCredentials: (providerId: string) => Promise<CredentialsResponse>;
  refreshCredentials?: (providerId: string) => Promise<CredentialsResponse>;
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch; // default: global fetch — injectable for tests
  isReady?: () => boolean; // default: () => true — controls /health
  configSecret?: string; // One-time config secret (from CONFIG_SECRET env var)
  preConfigured?: boolean; // true when credentials come via env vars (fresh sidecar)
  /**
   * OAuth token cache. Required when the sidecar serves OAuth-mode LLM
   * configs (`config.llm.authMode === "oauth"`). Production server.ts
   * builds one against the platform API; tests pass a stub.
   */
  oauthTokenCache?: OAuthTokenCache;
  /**
   * Run identifier for the agent run this sidecar serves. Used to
   * scope the MCP blob cache — a single sidecar process serves a single
   * run, so the run id can be set once at boot. Defaults to `"unknown"`
   * for tests; production sets it via the platform on container create
   * / `/configure`.
   */
  runId?: string;
}

/**
 * Headers forwarded from the upstream LLM provider verbatim. Limited to
 * the ones the in-container agent legitimately needs to react to:
 *
 *   - `Content-Type` — required for the agent to parse the body
 *   - `Retry-After`, `RateLimit*` — required for backoff on 429
 *   - `x-request-id` — useful for cross-correlating provider-side errors
 *
 * Everything else (Set-Cookie, hop-by-hop, internal Anthropic headers) is
 * dropped to keep the sidecar↔agent boundary tight.
 */
const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-request-id",
];

/**
 * Canonical casing for headers whose draft / standard spellings don't
 * match the naive Title-Case derivation. Generic Title-Casing turns
 * `ratelimit-limit` into `Ratelimit-Limit`, but the IETF RateLimit draft
 * (`draft-ietf-httpapi-ratelimit-headers`) and the Standard Webhooks
 * `X-RateLimit-*` family both use `RateLimit` as a single CamelCase token.
 * Some clients are case-sensitive on these — preserve the canonical form.
 */
const HEADER_CANONICAL_CASE: Record<string, string> = {
  "ratelimit-limit": "RateLimit-Limit",
  "ratelimit-remaining": "RateLimit-Remaining",
  "ratelimit-reset": "RateLimit-Reset",
  "ratelimit-policy": "RateLimit-Policy",
  "x-ratelimit-limit": "X-RateLimit-Limit",
  "x-ratelimit-remaining": "X-RateLimit-Remaining",
  "x-ratelimit-reset": "X-RateLimit-Reset",
};

function passUpstream(upstream: Response): Response {
  const responseHeaders: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      // Re-cased to preserve canonical HTTP form for the agent. Special-cased
      // headers (RateLimit family) come from the lookup table; everything else
      // falls back to a generic Title-Case transform.
      const canonical =
        HEADER_CANONICAL_CASE[name] ??
        name.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
      responseHeaders[canonical] = value;
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/**
 * On non-2xx upstream responses, clone the body for the operator-facing
 * warn log (the agent still consumes the original stream). 2xx is silent —
 * normal traffic shouldn't pollute the log. Returns the original response.
 */
async function logOauthLlmResponse(
  providerId: string,
  targetUrl: string,
  upstream: Response,
): Promise<Response> {
  if (upstream.status >= 200 && upstream.status < 300) return upstream;
  let bodySample = "";
  try {
    bodySample = await upstream.clone().text();
  } catch {
    // body unreadable — log what we have
  }
  // Drop credential-bearing headers (set-cookie, www-authenticate, …)
  // before the response hits the operator log. We don't regex-scrub the
  // body sample — upstream JSON error payloads never echo bearer tokens
  // back, and a 200-char preview is enough to diagnose without amplifying
  // log noise.
  const responseHeaders = filterSensitiveHeaders(upstream.headers);
  const truncated = bodySample.length > 200 ? bodySample.slice(0, 200) + "…" : bodySample;
  logger.warn("oauth llm: upstream response non-2xx", {
    providerId,
    targetUrl,
    status: upstream.status,
    contentType: upstream.headers.get("content-type"),
    responseHeaders,
    bodySample: truncated,
  });
  return upstream;
}

function llmFetchErrorResponse(
  // Hono context — typed loosely to avoid coupling to its internal generics.
  c: { json: (body: unknown, status: number) => Response },
  targetUrl: string,
  err: unknown,
): Response {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  let domain: string | undefined;
  try {
    domain = new URL(targetUrl).hostname;
  } catch {}
  const suffix = code ? `: ${code}` : "";
  const domainHint = domain ? ` (${domain})` : "";
  return c.json({ error: `LLM request failed${suffix}${domainHint}` }, 502);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build the sidecar's HTTP surface.
 *
 *   - `GET  /health`     — readiness probe.
 *   - `POST /configure`  — one-time runtime config injection (run token,
 *                          platform API URL, proxy URL, LLM config).
 *                          Pooled sidecars require a CONFIG_SECRET; fresh
 *                          sidecars boot pre-configured via env and
 *                          permanently lock this route.
 *   - `ALL  /llm/*`      — reverse proxy to the platform-configured LLM
 *                          provider. The Pi SDK (in-container) calls
 *                          `${MODEL_BASE_URL}/v1/chat/completions` (or
 *                          equivalent) over HTTP — MCP `tools/call` is
 *                          unsuitable for a streamed completion the SDK
 *                          consumes natively. The sidecar swaps the
 *                          placeholder embedded in the SDK's auth header
 *                          for the real API key, then streams the
 *                          upstream response back to the agent without
 *                          buffering. The agent never sees the key.
 *   - `ALL  /mcp`        — JSON-RPC entrypoint mounted by `mountMcp`.
 *                          Exposes `provider_call`, `run_history`, and
 *                          `recall_memory` as MCP tools backed by the
 *                          credential-proxy core in `credential-proxy.ts`.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, fetchCredentials, cookieJar } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const isReady = deps.isReady ?? (() => true);
  const reportedAuthFailures = new Set<string>();

  const app = new Hono();

  // Health check for startup readiness (includes forward proxy readiness)
  app.get("/health", (c) => {
    if (!isReady()) {
      return c.json({ status: "degraded", proxy: "not ready" }, 503);
    }
    return c.json({ status: "ok" });
  });

  // Runtime configuration endpoint (used by sidecar pool for pre-warmed containers).
  // If CONFIG_SECRET is set, requires Authorization header and disables after first use.
  // If preConfigured is set, /configure is permanently locked (fresh sidecars with env vars).
  let configUsed = false;
  app.post("/configure", async (c) => {
    // Fresh sidecars receive credentials via env vars — /configure is permanently locked
    if (deps.preConfigured) {
      return c.json({ error: "Already configured" }, 403);
    }

    // Enforce one-time config secret when set (pooled sidecars)
    if (deps.configSecret) {
      if (configUsed) {
        return c.json({ error: "Already configured" }, 403);
      }
      const auth = c.req.header("Authorization") ?? "";
      const expected = `Bearer ${deps.configSecret}`;
      // Constant-time comparison to prevent timing attacks
      if (auth.length !== expected.length) {
        return c.json({ error: "Unauthorized" }, 403);
      }
      const authBuf = Buffer.from(auth);
      const expBuf = Buffer.from(expected);
      if (!timingSafeEqual(authBuf, expBuf)) {
        return c.json({ error: "Unauthorized" }, 403);
      }
    }

    const body = await c.req.json<{
      runToken?: string;
      platformApiUrl?: string;
      proxyUrl?: string;
      llm?: LlmProxyConfig;
    }>();
    if (body.runToken) config.runToken = body.runToken;
    if (body.platformApiUrl) config.platformApiUrl = body.platformApiUrl;
    if (body.proxyUrl !== undefined) config.proxyUrl = body.proxyUrl;
    if (body.llm !== undefined) {
      if (body.llm && isBlockedUrl(body.llm.baseUrl)) {
        return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
      }
      config.llm = body.llm;
    }

    configUsed = true;

    // Reset cookie jar for new run context
    cookieJar.clear();
    return c.json({ status: "configured" });
  });

  // LLM reverse proxy. Two modes:
  //
  //   - api_key (legacy): the Pi SDK formats every header (auth, beta,
  //     identity) using the platform-supplied placeholder; we swap the
  //     placeholder for the real key. Request/response bodies stream
  //     through zero-copy.
  //   - oauth: the sidecar resolves a fresh access token from the
  //     platform (`/internal/oauth-token/:id`), injects bearer +
  //     provider identity headers, applies the declarative body
  //     transforms read from `wireFormat` (system-prepend, force-stream,
  //     force-store). Bodies are buffered (transform requirement) but
  //     the response still streams. On 401 we refresh + retry once; on
  //     the wireFormat-configured adaptive-retry trigger we strip the
  //     designated header token and retry once.
  app.all("/llm/*", async (c) => {
    if (!config.llm) {
      return c.json({ error: "LLM proxy not configured" }, 503);
    }

    if (isBlockedUrl(config.llm.baseUrl)) {
      return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
    }

    if (config.llm.authMode === "oauth") {
      return handleOauthLlmRequest(c, config.llm);
    }

    const apiKeyConfig = config.llm; // discriminated narrowing
    const baseUrl = apiKeyConfig.baseUrl;

    const path = c.req.path.slice("/llm".length) || "/";
    const qs = new URL(c.req.url).search;
    const targetUrl = `${baseUrl}${path}${qs}`;

    const filtered = filterHeaders(c.req.header());
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(filtered)) {
      forwardedHeaders[key] = value.includes(apiKeyConfig.placeholder)
        ? value.replace(apiKeyConfig.placeholder, apiKeyConfig.apiKey)
        : value;
    }

    const method = c.req.method;
    const body = method !== "GET" && method !== "HEAD" ? (c.req.raw.body ?? undefined) : undefined;

    let upstream: Response;
    try {
      upstream = await fetchFn(targetUrl, {
        method,
        headers: forwardedHeaders,
        body,
        signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err) {
      return llmFetchErrorResponse(c, targetUrl, err);
    }

    return passUpstream(upstream);
  });

  async function handleOauthLlmRequest(
    c: Context,
    llmConfig: LlmProxyOauthConfig,
  ): Promise<Response> {
    const tokenCache = deps.oauthTokenCache;
    if (!tokenCache) {
      return c.json({ error: "OAuth token cache not configured" }, 503);
    }

    let token: CachedToken;
    try {
      token = await tokenCache.getToken(llmConfig.credentialId);
    } catch (err) {
      if (err instanceof NeedsReconnectionError) {
        return c.json(
          { error: "OAuth connection needs reconnection", needsReconnection: true },
          401,
        );
      }
      return c.json({ error: `OAuth token resolution failed: ${stringifyError(err)}` }, 502);
    }

    const baseUrl = llmConfig.baseUrl;
    if (isBlockedUrl(baseUrl)) {
      return c.json({ error: "Resolved OAuth base URL targets a blocked network range" }, 403);
    }

    const incomingPath = c.req.path.slice("/llm".length) || "/";
    const qs = new URL(c.req.url).search;
    const rewrite = llmConfig.wireFormat?.rewriteUrlPath;
    const rewrittenPath = rewrite ? incomingPath.replace(rewrite.from, rewrite.to) : incomingPath;
    const targetUrl = `${baseUrl}${rewrittenPath}${qs}`;

    const method = c.req.method;
    const filtered = filterHeaders(c.req.header());
    const baseHeaders: Record<string, string> = { ...filtered };

    // Strip any auth/api-key/UA/accept the agent SDK may have set — the
    // OAuth path forces all four (real bearer + provider-mandated fingerprint
    // headers). Case-insensitive removal: filterHeaders preserves the caller's
    // original casing, so we delete every variant before re-injecting our own.
    const STRIP_HEADERS = ["authorization", "x-api-key", "user-agent", "accept"];
    for (const key of Object.keys(baseHeaders)) {
      if (STRIP_HEADERS.includes(key.toLowerCase())) {
        delete baseHeaders[key];
      }
    }

    const identityHeaders = buildIdentityHeaders(llmConfig.wireFormat, token);
    let forwardedHeaders: Record<string, string> = {
      ...baseHeaders,
      ...identityHeaders,
      authorization: `Bearer ${token.accessToken}`,
    };

    let bodyText: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      bodyText = await c.req.raw.text();
      if (bodyText) {
        try {
          bodyText = transformBody(llmConfig.wireFormat, bodyText);
        } catch (err) {
          if (err instanceof TransformBodyTooLargeError) {
            return c.json(
              {
                error: err.message,
                limit: err.limitBytes,
                actual: err.actualBytes,
                envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
              },
              413,
            );
          }
          throw err;
        }
        // Refresh content-length to match the transformed body so the
        // upstream doesn't read a stale value forwarded from the agent.
        forwardedHeaders["content-length"] = String(new TextEncoder().encode(bodyText).byteLength);
      }
    }

    const doFetch = async (
      headers: Record<string, string>,
      body: string | undefined,
    ): Promise<Response> => {
      return fetchFn(targetUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
      } as RequestInit);
    };

    let upstream: Response;
    try {
      upstream = await doFetch(forwardedHeaders, bodyText);
    } catch (err) {
      logger.error("oauth llm: upstream fetch threw", {
        providerId: llmConfig.providerId,
        targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return llmFetchErrorResponse(c, targetUrl, err);
    }

    upstream = await logOauthLlmResponse(llmConfig.providerId, targetUrl, upstream);

    // 401 retry: invalidate cache, force-refresh token, replay once.
    if (upstream.status === 401) {
      tokenCache.invalidate(llmConfig.credentialId);
      let refreshed: CachedToken;
      try {
        refreshed = await tokenCache.forceRefresh(llmConfig.credentialId);
      } catch (err) {
        if (err instanceof NeedsReconnectionError) {
          return c.json(
            { error: "OAuth connection needs reconnection", needsReconnection: true },
            401,
          );
        }
        // Fall through with the original 401 — best-effort.
        return passUpstream(upstream);
      }
      forwardedHeaders = {
        ...forwardedHeaders,
        ...buildIdentityHeaders(llmConfig.wireFormat, refreshed),
        authorization: `Bearer ${refreshed.accessToken}`,
      };
      try {
        upstream = await doFetch(forwardedHeaders, bodyText);
      } catch (err) {
        return llmFetchErrorResponse(c, targetUrl, err);
      }
      upstream = await logOauthLlmResponse(llmConfig.providerId, targetUrl, upstream);
      // No second-level retry on the retry — propagate whatever we got.
    }

    // Adaptive header retry: provider declares the policy (status +
    // body pattern → header-token strip) via `wireFormat.adaptiveRetry`.
    // Best-effort, replays the request once.
    const adaptivePolicy = llmConfig.wireFormat?.adaptiveRetry;
    if (adaptivePolicy && upstream.status === adaptivePolicy.status) {
      const text = await upstream.clone().text();
      const adapted = adaptHeaderForRetry(adaptivePolicy, upstream.status, text, forwardedHeaders);
      if (adapted) {
        try {
          upstream = await doFetch(adapted.headers, bodyText);
          forwardedHeaders = adapted.headers;
        } catch (err) {
          return llmFetchErrorResponse(c, targetUrl, err);
        }
      }
    }

    return passUpstream(upstream);
  }

  // MCP exposure — the agent-facing surface for `provider_call`,
  // `run_history`, and `recall_memory`. `mountMcp` forwards
  // `provider_call` directly to `executeProviderCall` via the shared
  // `proxyDeps` (no header round-trip).
  const blobStore = new BlobStore(deps.runId ?? "unknown");
  // Token-aware budgeting (issue #390): every tool output is gated by
  // a per-call inline cap and a cumulative run-level ceiling. Both
  // are configurable via env vars; defaults stay conservative for
  // OSS / dev (200 K-token context window equivalent).
  const inlineCapTokens = readPositiveTokenEnv(
    "SIDECAR_INLINE_TOOL_OUTPUT_TOKENS",
    DEFAULT_INLINE_OUTPUT_TOKENS,
  );
  const runBudgetTokens = readPositiveTokenEnv(
    "SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS",
    DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  );
  const tokenBudget = new TokenBudget({ inlineCapTokens, runBudgetTokens });
  mountMcp(app, {
    blobStore,
    tokenBudget,
    proxyDeps: {
      config,
      cookieJar,
      fetchFn,
      fetchCredentials,
      ...(deps.refreshCredentials ? { refreshCredentials: deps.refreshCredentials } : {}),
      reportedAuthFailures,
    },
  });

  return app;
}
