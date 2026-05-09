// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { mountMcp } from "./mcp.ts";
import { BlobStore } from "./blob-store.ts";
import {
  LLM_PROXY_TIMEOUT_MS,
  filterHeaders,
  isBlockedUrl,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyConfig,
} from "./helpers.ts";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  readPositiveTokenEnv,
} from "./token-budget.ts";

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
   * Run identifier for the agent run this sidecar serves. Used to
   * scope the MCP blob cache — a single sidecar process serves a single
   * run, so the run id can be set once at boot. Defaults to `"unknown"`
   * for tests; production sets it via the platform on container create
   * / `/configure`.
   */
  runId?: string;
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

  // LLM reverse proxy. The Pi SDK formats every header (auth, beta,
  // identity) using the platform-supplied placeholder; we swap the
  // placeholder value for the real key in every header before
  // forwarding. Request and response bodies stream through (zero-copy).
  app.all("/llm/*", async (c) => {
    if (!config.llm) {
      return c.json({ error: "LLM proxy not configured" }, 503);
    }

    const baseUrl = config.llm.baseUrl;

    // Block SSRF — baseUrl comes from user config, must not target private networks
    if (isBlockedUrl(baseUrl)) {
      return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
    }

    // Extract path after /llm (e.g. /llm/v1/messages → /v1/messages)
    const path = c.req.path.slice("/llm".length) || "/";
    const qs = new URL(c.req.url).search;
    const targetUrl = `${baseUrl}${path}${qs}`;

    // Forward headers — replace placeholder with real key, strip hop-by-hop
    const filtered = filterHeaders(c.req.header());
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(filtered)) {
      forwardedHeaders[key] = value.includes(config.llm.placeholder)
        ? value.replace(config.llm.placeholder, config.llm.apiKey)
        : value;
    }

    // Stream-through request body
    const method = c.req.method;
    const body = method !== "GET" && method !== "HEAD" ? (c.req.raw.body ?? undefined) : undefined;

    let upstream: Response;
    try {
      upstream = await fetchFn(targetUrl, {
        method,
        headers: forwardedHeaders,
        body,
        signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
        // `duplex: "half"` is required when the body is a ReadableStream
        // (streaming upload). It is not part of the standard `RequestInit`
        // type, so the cast is intentional.
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
      let domain: string | undefined;
      try {
        domain = new URL(targetUrl).hostname;
      } catch {}
      const suffix = code ? `: ${code}` : "";
      const domainHint = domain ? ` (${domain})` : "";
      return c.json({ error: `LLM request failed${suffix}${domainHint}` }, 502);
    }

    // Stream-through response (zero-copy — no buffering/truncation)
    const responseHeaders: Record<string, string> = {};
    const ct = upstream.headers.get("content-type");
    if (ct) responseHeaders["Content-Type"] = ct;

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

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
