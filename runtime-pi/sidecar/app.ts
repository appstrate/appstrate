// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  ABSOLUTE_MAX_RESPONSE_SIZE,
  MAX_SUBSTITUTE_BODY_SIZE,
  STREAMING_THRESHOLD,
  MAX_STREAMED_BODY_SIZE,
  OUTBOUND_TIMEOUT_MS,
  LLM_PROXY_TIMEOUT_MS,
  filterHeaders,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  isBlockedUrl,
  applyInjectedCredentialHeader,
  normalizeAuthScheme,
  type SidecarConfig,
  type CredentialsResponse,
  type LlmProxyConfig,
} from "./helpers.ts";

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
    const responseHeaders: Record<string, string> = {};
    const ct = result.response.headers.get("content-type");
    if (ct) responseHeaders["Content-Type"] = ct;

    return new Response(result.response.body, {
      status: result.response.status,
      headers: responseHeaders,
    });
  });

  // Transparent credential-injecting proxy
  app.all("/proxy", async (c) => {
    // 1. Extract routing headers
    const providerId = c.req.header("X-Provider");
    const targetUrl = c.req.header("X-Target");
    const substituteBody = c.req.header("X-Substitute-Body");

    if (!providerId) {
      return c.json({ error: "Missing X-Provider header" }, 400);
    }
    if (!targetUrl) {
      return c.json({ error: "Missing X-Target header" }, 400);
    }

    // 1b. Validate providerId format (prevent path traversal)
    if (!PROVIDER_ID_RE.test(providerId)) {
      return c.json({ error: "Invalid X-Provider format" }, 400);
    }

    // 2. Fetch credentials
    let creds: CredentialsResponse;
    try {
      creds = await fetchCredentials(providerId);
    } catch (err) {
      return c.json(
        { error: `Credential fetch failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    // 3. Substitute {{variable}} in target URL
    const resolvedUrl = substituteVars(targetUrl, creds.credentials);

    // 3b. Check for unresolved placeholders in URL
    const unresolvedInUrl = findUnresolvedPlaceholders(resolvedUrl);
    if (unresolvedInUrl.length) {
      return c.json(
        { error: `Unresolved placeholders in URL: {{${unresolvedInUrl.join()}}}` },
        400,
      );
    }

    // 4. Validate URL against authorizedUris (or block internal targets)
    if (creds.allowAllUris) {
      // Allow all URLs but still block internal/private networks
      if (isBlockedUrl(resolvedUrl)) {
        return c.json({ error: "URL targets a blocked network range" }, 403);
      }
    } else if (creds.authorizedUris && creds.authorizedUris.length) {
      if (!matchesAuthorizedUri(resolvedUrl, creds.authorizedUris)) {
        return c.json(
          {
            error: `URL not authorized for provider "${providerId}". Allowed: ${creds.authorizedUris.join(", ")}`,
          },
          403,
        );
      }
    } else {
      // No authorizedUris — apply SSRF safety net
      if (isBlockedUrl(resolvedUrl)) {
        return c.json({ error: "URL targets a blocked network range" }, 403);
      }
    }

    // 5. Build forwarded headers (remove routing + hop-by-hop headers)
    //    Keep raw templates for potential retry with refreshed credentials
    const rawHeaders = filterHeaders(c.req.header(), CREDENTIAL_PROXY_SKIP);

    // Infrastructure proxy (agent-level, transparent)
    const resolvedProxy = config.proxyUrl || "";

    // 5b. Resolve headers with initial credentials and check for unresolved placeholders
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      forwardedHeaders[key] = substituteVars(value, creds.credentials);
    }
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      const unresolved = findUnresolvedPlaceholders(value);
      if (unresolved.length) {
        return c.json(
          { error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}` },
          400,
        );
      }
    }

    // 6. Handle body — choose between buffered and streaming paths.
    //
    //    Buffered path (default): read the full body into memory so we
    //    can replay it on a 401 refresh-and-retry. Required when
    //    X-Substitute-Body is set (we need the bytes in memory to
    //    perform credential placeholder substitution) or when the
    //    declared content-length is below STREAMING_THRESHOLD.
    //
    //    Streaming path: when content-length exceeds STREAMING_THRESHOLD
    //    AND no X-Substitute-Body is requested, pass the raw body
    //    `ReadableStream` directly to fetch with `duplex: "half"`. This
    //    keeps memory bound on large uploads (Drive resumable uploads,
    //    bulk exports) at the cost of breaking the transparent
    //    401-refresh-and-retry — request bodies are not replayable.
    //    The retry is delegated to the AFPS resolver layer, whose
    //    `{ fromFile }` resolution is reproducible.
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const declaredContentLength = parseInt(c.req.header("content-length") || "0", 10);
    const useStreamingRequest =
      hasBody && !substituteBody && declaredContentLength > STREAMING_THRESHOLD;

    let rawBodyBytes: ArrayBuffer | undefined;
    let rawBodyText: string | undefined; // lazily decoded only when substituteBody is set

    if (hasBody && !useStreamingRequest) {
      if (declaredContentLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      const buffered = await c.req.arrayBuffer();
      if (buffered.byteLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      rawBodyBytes = buffered;
      if (substituteBody) {
        rawBodyText = new TextDecoder().decode(buffered);
      }
    } else if (useStreamingRequest) {
      // Apply the streaming hard cap before we even open the upstream
      // socket. We can only enforce the declared content-length here —
      // a chunked / unbounded upload that exceeds the cap mid-stream
      // will be terminated by upstream timeout / our outbound 30s clock.
      if (declaredContentLength > MAX_STREAMED_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
    }

    /** Build the request body with credential substitution applied. */
    const buildBody = (
      credentials: Record<string, string>,
    ): ArrayBuffer | string | ReadableStream | undefined => {
      if (useStreamingRequest) {
        // Stream the raw incoming body straight through to upstream.
        // The body is consumed once — no retry replay possible.
        return c.req.raw.body ?? undefined;
      }
      if (!rawBodyBytes) return undefined;
      if (substituteBody && rawBodyText) {
        const substituted = substituteVars(rawBodyText, credentials);
        const unresolved = findUnresolvedPlaceholders(substituted);
        if (unresolved.length) return undefined; // caller checks this
        return substituted;
      }
      return rawBodyBytes;
    };

    // Check placeholder resolution before first request
    if (substituteBody && rawBodyText) {
      const testBody = substituteVars(rawBodyText, creds.credentials);
      const unresolvedInBody = findUnresolvedPlaceholders(testBody);
      if (unresolvedInBody.length) {
        return c.json(
          { error: `Unresolved placeholders in body: {{${unresolvedInBody.join()}}}` },
          400,
        );
      }
    }

    /** Make an upstream request, substituting credentials into raw header templates. */
    const doUpstreamRequest = async (activeCreds: CredentialsResponse): Promise<FetchResult> => {
      const resolvedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        resolvedHeaders[key] = substituteVars(value, activeCreds.credentials);
      }
      // Server-side credential injection. When the provider manifest
      // declares a `credentialHeaderName` (e.g. `Authorization` for OAuth,
      // `X-Api-Key` for API-key providers), the sidecar writes the final
      // header server-side from `credentials[credentialFieldName]`. The
      // agent never touches the credential value — no placeholders on
      // the wire, no way for the LLM to exfiltrate the token through the
      // header name. Caller override wins on case-insensitive match so
      // an agent can still pass a per-call token through input when
      // exotic dual-auth flows need it.
      applyInjectedCredentialHeader(resolvedHeaders, activeCreds);
      normalizeAuthScheme(resolvedHeaders);
      // Re-inject cookies (not credential-dependent)
      const storedCookies2 = cookieJar.get(providerId);
      if (storedCookies2 && storedCookies2.length) {
        const existing = resolvedHeaders["cookie"] || "";
        resolvedHeaders["cookie"] = existing
          ? `${existing}; ${storedCookies2.join("; ")}`
          : storedCookies2.join("; ");
      }

      const body = buildBody(activeCreds.credentials);
      const init: RequestInit & Record<string, unknown> = {
        method,
        headers: resolvedHeaders,
        body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        proxy: resolvedProxy || undefined,
      };
      if (body instanceof ReadableStream) {
        // Required by fetch when sending a streaming request body.
        init.duplex = "half";
      }
      return fetchOrError(c, fetchFn, "Upstream request failed", resolvedUrl, init);
    };

    // 7. Make the first request to the target
    let result = await doUpstreamRequest(creds);
    if (!result.ok) return result.errorResponse;
    let targetRes = result.response;
    let authRefreshed = false;

    // 7b. Retry on 401: refresh credentials and retry once. The refresh
    //     endpoint returns the full CredentialsResponse (including
    //     headerName / prefix / fieldName), so credential injection uses
    //     the freshly rotated token without any extra plumbing.
    //
    //     Streaming-request mode: the request body has already been
    //     consumed by the first upstream call, so we cannot replay it.
    //     We still refresh the credentials (so the *next* call from the
    //     caller succeeds) and surface the 401 with `X-Auth-Refreshed:
    //     true` — the AFPS resolver layer interprets this as "the
    //     transient auth failure has been resolved, retry idempotently".
    if (
      targetRes.status === 401 &&
      deps.refreshCredentials &&
      config.platformApiUrl &&
      config.runToken &&
      !reportedAuthFailures.has(providerId)
    ) {
      try {
        const refreshed = await deps.refreshCredentials(providerId);
        if (!useStreamingRequest) {
          const retryResult = await doUpstreamRequest(refreshed);
          if (retryResult.ok) {
            targetRes = retryResult.response;
          }
        } else {
          // Credentials were rotated but we cannot replay the body —
          // the caller will see 401 + X-Auth-Refreshed and retry.
          authRefreshed = true;
        }
      } catch {
        // Refresh itself failed (invalid_grant, revoked token) — fall through to report
      }
    }

    // 8. Capture Set-Cookie headers into cookie jar
    const setCookieHeaders = targetRes.headers.getSetCookie();
    if (setCookieHeaders.length) {
      // Extract cookie name=value pairs (strip attributes like Path, Expires, etc.)
      const cookieValues = setCookieHeaders.map((h) => h.split(";")[0]!.trim());
      // Merge with existing jar: update by cookie name, keep others
      const existing = cookieJar.get(providerId) ?? [];
      const byName = new Map<string, string>();
      for (const ck of existing) {
        const name = ck.split("=")[0]!;
        byName.set(name, ck);
      }
      for (const ck of cookieValues) {
        const name = ck.split("=")[0]!;
        byName.set(name, ck);
      }
      cookieJar.set(providerId, [...byName.values()]);
    }

    // 9. Report auth failures to platform (once per provider per run, only if retry didn't fix it)
    if (
      targetRes.status === 401 &&
      config.platformApiUrl &&
      config.runToken &&
      !reportedAuthFailures.has(providerId)
    ) {
      reportedAuthFailures.add(providerId);
      fetchFn(`${config.platformApiUrl}/internal/connections/report-auth-failure`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ providerId }),
      }).catch(() => {});
    }

    // 10. Forward upstream response — choose between buffered (default,
    //     with truncation) and streaming (zero-copy pass-through) paths.
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

      const streamHeaders: Record<string, string> = { "Content-Type": contentType };
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
    const body = truncated ? responseBytes.slice(0, maxSize) : responseBytes;

    const responseHeaders: Record<string, string> = { "Content-Type": contentType };
    if (truncated) responseHeaders["X-Truncated"] = "true";
    if (authRefreshed) responseHeaders["X-Auth-Refreshed"] = "true";

    return new Response(body, { status: targetRes.status, headers: responseHeaders });
  });

  return app;
}
