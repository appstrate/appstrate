// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  ABSOLUTE_MAX_RESPONSE_SIZE,
  MAX_SUBSTITUTE_BODY_SIZE,
  OUTBOUND_TIMEOUT_MS,
  LLM_PROXY_TIMEOUT_MS,
  filterHeaders,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  isBlockedUrl,
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

const CREDENTIAL_PROXY_SKIP = new Set(["x-provider", "x-target", "x-substitute-body"]);

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

  // Storage proxy — forward /storage/* and /agent-storage/* to the platform API.
  // Used by agent extensions to access user Documents and session files.
  const storageProxy = (prefix: string, internalPrefix: string) => {
    app.all(`/${prefix}/*`, async (c) => {
      const subPath = c.req.path.replace(`/${prefix}`, `/internal/${internalPrefix}`);
      const qs = new URL(c.req.url).search;
      const url = `${config.platformApiUrl}${subPath}${qs}`;

      const method = c.req.method;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.runToken}`,
      };
      const contentType = c.req.header("content-type");
      if (contentType) headers["Content-Type"] = contentType;

      const hasBody = method !== "GET" && method !== "HEAD";
      const result = await fetchOrError(c, fetchFn, `Storage proxy (${prefix}) failed`, url, {
        method,
        headers,
        ...(hasBody ? { body: await c.req.arrayBuffer() } : {}),
      });
      if (!result.ok) return result.errorResponse;

      const body = await result.response.arrayBuffer();
      return c.body(body, result.response.status as any, {
        "Content-Type": result.response.headers.get("Content-Type") || "application/octet-stream",
      });
    });
  };
  storageProxy("storage", "storage");
  storageProxy("agent-storage", "agent-storage");

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
      // @ts-expect-error - Bun supports duplex for streaming request bodies
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
    if (!result.ok) return result.errorResponse;

    // Stream-through response (zero-copy — no buffering/truncation)
    const responseHeaders: Record<string, string> = {};
    const ct = result.response.headers.get("content-type");
    if (ct) responseHeaders["Content-Type"] = ct;

    return c.body(result.response.body, result.response.status, responseHeaders);
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

    // 6. Handle body — buffer for potential retry on 401.
    //    Use ArrayBuffer to preserve binary data (e.g. XLSX uploads).
    //    Only decode as text when X-Substitute-Body requires placeholder replacement.
    const method = c.req.method;
    let rawBodyBytes: ArrayBuffer | undefined;
    let rawBodyText: string | undefined; // lazily decoded only when substituteBody is set

    if (method !== "GET" && method !== "HEAD") {
      const contentLength = parseInt(c.req.header("content-length") || "0", 10);
      if (contentLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      rawBodyBytes = await c.req.arrayBuffer();
      if (rawBodyBytes.byteLength > MAX_SUBSTITUTE_BODY_SIZE) {
        return c.json({ error: "Request body too large" }, 413);
      }
      if (substituteBody) {
        rawBodyText = new TextDecoder().decode(rawBodyBytes);
      }
    }

    /** Build the request body with credential substitution applied. */
    const buildBody = (credentials: Record<string, string>): BodyInit | undefined => {
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
    const doUpstreamRequest = async (credentials: Record<string, string>): Promise<FetchResult> => {
      const resolvedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        resolvedHeaders[key] = substituteVars(value, credentials);
      }
      // Normalize auth headers: ensure space after scheme (e.g. "Bearertoken" → "Bearer token").
      // LLMs sometimes generate "Bearer{{access_token}}" without a space, which produces
      // a malformed header that providers reject with 401.
      const authKey = Object.keys(resolvedHeaders).find((k) => k.toLowerCase() === "authorization");
      if (authKey) {
        resolvedHeaders[authKey] = resolvedHeaders[authKey]!.replace(
          /^(Bearer|Basic|Token)(?=[^\s])/i,
          "$1 ",
        );
      }
      // Re-inject cookies (not credential-dependent)
      const storedCookies2 = cookieJar.get(providerId);
      if (storedCookies2 && storedCookies2.length) {
        const existing = resolvedHeaders["cookie"] || "";
        resolvedHeaders["cookie"] = existing
          ? `${existing}; ${storedCookies2.join("; ")}`
          : storedCookies2.join("; ");
      }

      const body = buildBody(credentials);
      return fetchOrError(c, fetchFn, "Upstream request failed", resolvedUrl, {
        method,
        headers: resolvedHeaders,
        body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        // @ts-expect-error - Bun supports proxy option natively
        proxy: resolvedProxy || undefined,
      });
    };

    // 7. Make the first request to the target
    let result = await doUpstreamRequest(creds.credentials);
    if (!result.ok) return result.errorResponse;
    let targetRes = result.response;

    // 7b. Retry on 401: refresh credentials and retry once
    if (
      targetRes.status === 401 &&
      deps.refreshCredentials &&
      config.platformApiUrl &&
      config.runToken &&
      !reportedAuthFailures.has(providerId)
    ) {
      try {
        const refreshed = await deps.refreshCredentials(providerId);
        const retryResult = await doUpstreamRequest(refreshed.credentials);
        if (retryResult.ok) {
          targetRes = retryResult.response;
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

    // 9. Forward upstream response transparently (pass-through proxy)
    const responseText = await targetRes.text();
    const requestedMaxSize = parseInt(c.req.header("x-max-response-size") || "0", 10);
    const maxSize =
      requestedMaxSize > 0
        ? Math.min(requestedMaxSize, ABSOLUTE_MAX_RESPONSE_SIZE)
        : MAX_RESPONSE_SIZE;
    const truncated = responseText.length > maxSize;
    const text = truncated ? responseText.slice(0, maxSize) : responseText;

    const contentType = targetRes.headers.get("content-type") || "application/octet-stream";
    const responseHeaders: Record<string, string> = { "Content-Type": contentType };
    if (truncated) {
      responseHeaders["X-Truncated"] = "true";
    }

    // Report auth failures to platform (once per provider per run, only if retry didn't fix it)
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

    return c.body(text, targetRes.status, responseHeaders);
  });

  return app;
}
