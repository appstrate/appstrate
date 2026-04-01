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
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch;        // default: global fetch — injectable for tests
  isReady?: () => boolean;       // default: () => true — controls /health
  configSecret?: string;         // One-time config secret (from CONFIG_SECRET env var)
  preConfigured?: boolean;       // true when credentials come via env vars (fresh sidecar)
}

const CREDENTIAL_PROXY_SKIP = new Set(["x-provider", "x-target", "x-substitute-body"]);

type FetchResult =
  | { ok: true; response: Response }
  | { ok: false; errorResponse: Response };

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
    try { domain = new URL(url).hostname; } catch {}
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
      executionToken?: string;
      platformApiUrl?: string;
      proxyUrl?: string;
      llm?: LlmProxyConfig;
    }>();
    if (body.executionToken) config.executionToken = body.executionToken;
    if (body.platformApiUrl) config.platformApiUrl = body.platformApiUrl;
    if (body.proxyUrl !== undefined) config.proxyUrl = body.proxyUrl;
    if (body.llm !== undefined) {
      if (body.llm && isBlockedUrl(body.llm.baseUrl)) {
        return c.json({ error: "LLM base URL targets a blocked network range" }, 403);
      }
      config.llm = body.llm;
    }

    configUsed = true;

    // Reset cookie jar for new execution context
    cookieJar.clear();
    return c.json({ status: "configured" });
  });

  // Execution history proxy
  app.get("/execution-history", async (c) => {
    const qs = new URL(c.req.url).search;
    const url = `${config.platformApiUrl}/internal/execution-history${qs}`;

    const result = await fetchOrError(c, fetchFn, "Execution history fetch failed", url, {
      headers: { Authorization: `Bearer ${config.executionToken}` },
    });
    if (!result.ok) return result.errorResponse;

    const body = await result.response.text();
    return c.body(body, result.response.status, {
      "Content-Type": result.response.headers.get("Content-Type") || "application/json",
    });
  });

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
    const body = method !== "GET" && method !== "HEAD"
      ? (c.req.raw.body ?? undefined)
      : undefined;

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
        return c.json(
          { error: "URL targets a blocked network range" },
          403,
        );
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
        return c.json(
          { error: "URL targets a blocked network range" },
          403,
        );
      }
    }

    // 5. Build forwarded headers (remove routing + hop-by-hop headers)
    const filtered = filterHeaders(c.req.header(), CREDENTIAL_PROXY_SKIP);
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(filtered)) {
      forwardedHeaders[key] = substituteVars(value, creds.credentials);
    }

    // Infrastructure proxy (flow-level, transparent)
    const resolvedProxy = config.proxyUrl || "";

    // 5b. Check for unresolved placeholders in headers
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      const unresolved = findUnresolvedPlaceholders(value);
      if (unresolved.length) {
        return c.json(
          { error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}` },
          400,
        );
      }
    }

    // 5c. Inject stored cookies from cookie jar
    const storedCookies = cookieJar.get(providerId);
    if (storedCookies && storedCookies.length) {
      const existing = forwardedHeaders["cookie"] || "";
      const merged = existing
        ? `${existing}; ${storedCookies.join("; ")}`
        : storedCookies.join("; ");
      forwardedHeaders["cookie"] = merged;
    }

    // 6. Handle body
    const method = c.req.method;
    let body: BodyInit | undefined;

    if (method !== "GET" && method !== "HEAD") {
      if (substituteBody) {
        // Check body size before buffering
        const contentLength = parseInt(c.req.header("content-length") || "0", 10);
        if (contentLength > MAX_SUBSTITUTE_BODY_SIZE) {
          return c.json({ error: "Request body too large" }, 413);
        }
        // Buffer body and substitute variables
        const rawBody = await c.req.text();
        if (rawBody.length > MAX_SUBSTITUTE_BODY_SIZE) {
          return c.json({ error: "Request body too large" }, 413);
        }
        body = substituteVars(rawBody, creds.credentials);
        // Check for unresolved placeholders in body
        const unresolvedInBody = findUnresolvedPlaceholders(body);
        if (unresolvedInBody.length) {
          return c.json(
            { error: `Unresolved placeholders in body: {{${unresolvedInBody.join()}}}` },
            400,
          );
        }
      } else {
        // Stream body through as-is
        body = c.req.raw.body ?? undefined;
      }
    }

    // 7. Make the request to the target (with timeout)
    const result = await fetchOrError(c, fetchFn, "Upstream request failed", resolvedUrl, {
      method,
      headers: forwardedHeaders,
      body,
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      // @ts-expect-error - Bun supports proxy option natively
      proxy: resolvedProxy || undefined,
      // @ts-expect-error - Bun supports duplex for streaming request bodies
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });
    if (!result.ok) return result.errorResponse;
    const targetRes = result.response;

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
    const maxSize = requestedMaxSize > 0
      ? Math.min(requestedMaxSize, ABSOLUTE_MAX_RESPONSE_SIZE)
      : MAX_RESPONSE_SIZE;
    const truncated = responseText.length > maxSize;
    const text = truncated ? responseText.slice(0, maxSize) : responseText;

    const contentType = targetRes.headers.get("content-type") || "application/octet-stream";
    const responseHeaders: Record<string, string> = { "Content-Type": contentType };
    if (truncated) {
      responseHeaders["X-Truncated"] = "true";
    }

    return c.body(text, targetRes.status, responseHeaders);
  });

  return app;
}
