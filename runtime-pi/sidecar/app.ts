// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { mountMcp } from "./mcp.ts";
import { BlobStore } from "./blob-store.ts";
import { DEPRECATION_HEADERS } from "./deprecation.ts";
import {
  MAX_RESPONSE_SIZE,
  ABSOLUTE_MAX_RESPONSE_SIZE,
  MAX_SUBSTITUTE_BODY_SIZE,
  STREAMING_THRESHOLD,
  MAX_STREAMED_BODY_SIZE,
  LLM_PROXY_TIMEOUT_MS,
  filterHeaders,
  isBlockedUrl,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyConfig,
} from "./helpers.ts";
import { executeProviderCall, type ProviderRequestBody } from "./credential-proxy.ts";

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
   * scope the MCP blob cache (Phase 3a of #276) — a single sidecar
   * process serves a single run, so the run id can be set once at
   * boot. Defaults to `"unknown"` for tests; production sets it via
   * the platform on container create / `/configure`.
   */
  runId?: string;
}

const CREDENTIAL_PROXY_SKIP = new Set([
  "x-provider",
  "x-target",
  "x-substitute-body",
  "x-stream-response",
  "x-max-response-size",
]);

type FetchResult = { ok: true; response: Response } | { ok: false; errorResponse: Response };

/**
 * Wrapper around fetch that converts network/timeout errors into a 502 JSON response.
 * Callers check `result.ok` to distinguish success from a pre-built error response.
 */
async function fetchOrError(
  c: { json: (body: unknown, status: number) => Response },
  fetchFn: typeof fetch,
  label: string,
  url: string,
  init: RequestInit & Record<string, unknown>,
): Promise<FetchResult> {
  try {
    return { ok: true, response: await fetchFn(url, init) };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
    let domain: string | undefined;
    try {
      domain = new URL(url).hostname;
    } catch {}
    const suffix = code ? `: ${code}` : "";
    const domainHint = domain ? ` (${domain})` : "";
    return {
      ok: false,
      errorResponse: c.json({ error: `${label}${suffix}${domainHint}` }, 502),
    };
  }
}

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

  // Run history proxy
  const runHistoryHandler = async (c: any) => {
    const qs = new URL(c.req.url).search;
    const url = `${config.platformApiUrl}/internal/run-history${qs}`;

    const result = await fetchOrError(c, fetchFn, "Run history fetch failed", url, {
      headers: { Authorization: `Bearer ${config.runToken}` },
    });
    if (!result.ok) return result.errorResponse;

    const body = await result.response.text();
    return c.body(body, result.response.status, {
      "Content-Type": result.response.headers.get("Content-Type") || "application/json",
    });
  };
  app.get("/run-history", runHistoryHandler);

  // LLM reverse proxy — replaces placeholder key with real API key, streams response.
  // The SDK formats all headers (auth, beta, identity) naturally using the placeholder;
  // we just swap the placeholder value for the real key in every header.
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

    const result = await fetchOrError(c, fetchFn, "LLM request failed", targetUrl, {
      method,
      headers: forwardedHeaders,
      body,
      signal: AbortSignal.timeout(LLM_PROXY_TIMEOUT_MS),
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
    if (!result.ok) return result.errorResponse;

    // Stream-through response (zero-copy — no buffering/truncation)
    const responseHeaders: Record<string, string> = { ...DEPRECATION_HEADERS };
    const ct = result.response.headers.get("content-type");
    if (ct) responseHeaders["Content-Type"] = ct;

    // Phase 3b of #276 — `/llm/*` is being phased out in favour of the
    // MCP `llm_complete` tool (Phase 3a). The Deprecation/Sunset
    // headers above signal this to operators on the 18-month timeline.
    return new Response(result.response.body, {
      status: result.response.status,
      headers: responseHeaders,
    });
  });

  // Transparent credential-injecting proxy. The HTTP envelope handling
  // (X-Provider/X-Target/X-Substitute-Body parsing, streaming-request
  // body branching, X-Stream-Response passthrough, response truncation)
  // is HTTP-only — the credential-proxy core lives in
  // `./credential-proxy.ts` and is also called directly by the MCP
  // `provider_call` tool handler without round-tripping through HTTP.
  app.all("/proxy", async (c) => {
    // 1. Parse routing headers.
    const providerId = c.req.header("X-Provider");
    const targetUrl = c.req.header("X-Target");
    const substituteBody = c.req.header("X-Substitute-Body");

    if (!providerId) return c.json({ error: "Missing X-Provider header" }, 400);
    if (!targetUrl) return c.json({ error: "Missing X-Target header" }, 400);

    // 2. Choose between buffered and streaming request bodies.
    //    Buffered (default): we hold the bytes in memory so the
    //    credential-proxy core can replay them on a 401 refresh.
    //    Required when X-Substitute-Body is set (we need the bytes to
    //    perform `{{variable}}` substitution) or when the declared
    //    Content-Length is below STREAMING_THRESHOLD.
    //    Streaming: when Content-Length is above STREAMING_THRESHOLD
    //    and X-Substitute-Body is NOT requested, we pass the raw
    //    request `ReadableStream` straight through. The body is
    //    consumed once — no replay; the caller sees 401 +
    //    X-Auth-Refreshed and retries idempotently.
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const declaredContentLength = parseInt(c.req.header("content-length") || "-1", 10);
    // RFC 9112 §6.1: "chunked" MUST be the last transfer-encoding.
    const te = (c.req.header("transfer-encoding") ?? "").toLowerCase();
    const isChunkedTransfer =
      te
        .split(",")
        .map((s) => s.trim())
        .at(-1) === "chunked";
    const hasUnknownLength = declaredContentLength < 0 && isChunkedTransfer;
    const useStreamingRequest =
      hasBody &&
      !substituteBody &&
      (declaredContentLength > STREAMING_THRESHOLD || hasUnknownLength);

    let body: ProviderRequestBody = { kind: "none" };
    if (hasBody && !useStreamingRequest) {
      if (declaredContentLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      const buffered = await c.req.arrayBuffer();
      if (buffered.byteLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      body = {
        kind: "buffered",
        bytes: buffered,
        ...(substituteBody ? { text: new TextDecoder().decode(buffered) } : {}),
      };
    } else if (useStreamingRequest) {
      // Apply the streaming hard cap before opening the upstream
      // socket. Chunked / unbounded uploads that exceed the cap
      // mid-stream are terminated by the outbound 30s timeout.
      if (declaredContentLength > MAX_STREAMED_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      body = { kind: "streaming", stream: c.req.raw.body ?? new ReadableStream() };
    }

    // 3. Strip routing + hop-by-hop headers before handing off.
    const callerHeaders = filterHeaders(c.req.header(), CREDENTIAL_PROXY_SKIP);

    // 4. Delegate the credential-proxy core (also used by MCP `provider_call`).
    const result = await executeProviderCall(
      {
        providerId,
        targetUrl,
        method,
        callerHeaders,
        body,
        substituteBody: !!substituteBody,
        proxyUrl: config.proxyUrl,
      },
      {
        config,
        cookieJar,
        fetchFn,
        fetchCredentials,
        ...(deps.refreshCredentials ? { refreshCredentials: deps.refreshCredentials } : {}),
        reportedAuthFailures,
      },
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.status as never);
    }

    const targetRes = result.response;
    const authRefreshed = result.authRefreshed;

    // 5. Forward upstream response — choose between buffered (default,
    //    with truncation) and streaming (zero-copy pass-through) paths.
    //
    //     Streaming path is opted in by the caller via
    //     `X-Stream-Response: 1`. The sidecar still enforces
    //     MAX_STREAMED_BODY_SIZE up front via the upstream
    //     Content-Length header when present — chunked / unknown-size
    //     responses fall back on the outbound timeout to bound memory.
    //     X-Truncated is irrelevant in streaming mode (the AFPS
    //     resolver decides when to spill bytes to disk via
    //     responseMode.toFile / maxInlineBytes).
    const wantsStreamResponse = c.req.header("x-stream-response") === "1";
    const contentType = targetRes.headers.get("content-type") || "application/octet-stream";

    if (wantsStreamResponse) {
      const upstreamLength = parseInt(targetRes.headers.get("content-length") || "0", 10);
      if (upstreamLength > MAX_STREAMED_BODY_SIZE) {
        // Drain to release the upstream connection promptly.
        targetRes.body?.cancel().catch(() => {});
        return c.json({ error: "Response body too large" }, 413);
      }

      // Phase 3b of #276 — the X-Stream-Response branch is being
      // phased out in favour of `provider_call` returning a
      // `resource_link` block (Phase 3a). The Deprecation/Sunset
      // headers signal the migration on the 18-month timeline.
      const streamHeaders: Record<string, string> = {
        "Content-Type": contentType,
        ...DEPRECATION_HEADERS,
      };
      if (authRefreshed) streamHeaders["X-Auth-Refreshed"] = "true";
      const upstreamCl = targetRes.headers.get("content-length");
      if (upstreamCl) streamHeaders["Content-Length"] = upstreamCl;

      return new Response(targetRes.body, {
        status: targetRes.status,
        headers: streamHeaders,
      });
    }

    // Buffered path (default): read as ArrayBuffer so non-UTF-8 bytes
    // (PDF, images, archives) are preserved byte-for-byte. Truncation
    // applied by byte length to match the actual payload size.
    const responseBytes = await targetRes.arrayBuffer();
    const requestedMaxSize = parseInt(c.req.header("x-max-response-size") || "0", 10);
    const maxSize =
      requestedMaxSize > 0
        ? Math.min(requestedMaxSize, ABSOLUTE_MAX_RESPONSE_SIZE)
        : MAX_RESPONSE_SIZE;
    const truncated = responseBytes.byteLength > maxSize;
    const responseBody = truncated ? responseBytes.slice(0, maxSize) : responseBytes;

    const responseHeaders: Record<string, string> = { "Content-Type": contentType };
    if (truncated) {
      responseHeaders["X-Truncated"] = "true";
      responseHeaders["X-Truncated-Size"] = String(responseBody.byteLength);
    }
    if (authRefreshed) responseHeaders["X-Auth-Refreshed"] = "true";

    return new Response(responseBody, { status: targetRes.status, headers: responseHeaders });
  });

  // MCP exposure (Phase 1+3a of #276). Mounts last so the tool handlers
  // for run_history / llm_complete (which still re-enter the app via
  // `app.request()`) hit the routes registered above. `provider_call`
  // takes the short-circuit and calls executeProviderCall directly via
  // proxyDeps — same credential injection, no header round-trip.
  const blobStore = new BlobStore(deps.runId ?? "unknown");
  mountMcp(app, {
    blobStore,
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
