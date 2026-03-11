import { Hono } from "hono";
import {
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  MAX_SUBSTITUTE_BODY_SIZE,
  OUTBOUND_TIMEOUT_MS,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  isBlockedUrl,
  type SidecarConfig,
  type CredentialsResponse,
} from "./helpers.ts";

export type { SidecarConfig } from "./helpers.ts";

export interface AppDeps {
  config: SidecarConfig;
  fetchCredentials: (providerId: string) => Promise<CredentialsResponse>;
  cookieJar: Map<string, string[]>;
  fetchFn?: typeof fetch;        // default: global fetch — injectable for tests
  isReady?: () => boolean;       // default: () => true — controls /health
  configSecret?: string;         // One-time config secret (from CONFIG_SECRET env var)
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
  let configUsed = false;
  app.post("/configure", async (c) => {
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
      let diff = 0;
      for (let i = 0; i < auth.length; i++) {
        diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      if (diff !== 0) {
        return c.json({ error: "Unauthorized" }, 403);
      }
    }

    const body = await c.req.json<{
      executionToken?: string;
      platformApiUrl?: string;
      proxyUrl?: string;
    }>();
    if (body.executionToken) config.executionToken = body.executionToken;
    if (body.platformApiUrl) config.platformApiUrl = body.platformApiUrl;
    if (body.proxyUrl !== undefined) config.proxyUrl = body.proxyUrl;

    configUsed = true;

    // Reset cookie jar for new execution context
    cookieJar.clear();
    return c.json({ status: "configured" });
  });

  // Execution history proxy
  app.get("/execution-history", async (c) => {
    const qs = c.req.url.split("?")[1] || "";
    const url = `${config.platformApiUrl}/internal/execution-history${qs ? `?${qs}` : ""}`;

    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${config.executionToken}` },
      });
    } catch (err) {
      return c.json(
        { error: `Execution history fetch failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    const body = await res.text();
    return c.body(body, res.status, {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
    });
  });

  // Transparent credential-injecting proxy
  app.all("/proxy", async (c) => {
    // 1. Extract routing headers
    const providerId = c.req.header("X-Provider");
    const targetUrl = c.req.header("X-Target");
    const substituteBody = c.req.header("X-Substitute-Body");
    const proxyHeader = c.req.header("X-Proxy");

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
    if (unresolvedInUrl.length > 0) {
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
    } else if (creds.authorizedUris && creds.authorizedUris.length > 0) {
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

    // 5. Build forwarded headers (remove routing headers)
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.req.header())) {
      const lower = key.toLowerCase();
      if (
        lower === "x-provider" ||
        lower === "x-target" ||
        lower === "x-substitute-body" ||
        lower === "x-proxy" ||
        lower === "host" ||
        lower === "connection" ||
        lower === "transfer-encoding" ||
        lower === "content-length"
      ) {
        continue;
      }
      forwardedHeaders[key] = substituteVars(value, creds.credentials);
    }

    // Resolve proxy: X-Proxy header (agent-driven) takes priority, then env PROXY_URL
    const resolvedProxy = (proxyHeader ? substituteVars(proxyHeader, creds.credentials) : "")
      || config.proxyUrl
      || "";

    if (resolvedProxy) {
      const unresolvedInProxy = findUnresolvedPlaceholders(resolvedProxy);
      if (unresolvedInProxy.length > 0) {
        return c.json(
          { error: `Unresolved placeholders in X-Proxy: {{${unresolvedInProxy.join()}}}` },
          400,
        );
      }
    }

    // 5b. Check for unresolved placeholders in headers
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      const unresolved = findUnresolvedPlaceholders(value);
      if (unresolved.length > 0) {
        return c.json(
          { error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}` },
          400,
        );
      }
    }

    // 5c. Inject stored cookies from cookie jar
    const storedCookies = cookieJar.get(providerId);
    if (storedCookies && storedCookies.length > 0) {
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
        if (unresolvedInBody.length > 0) {
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
    let targetRes: Response;
    try {
      targetRes = await fetchFn(resolvedUrl, {
        method,
        headers: forwardedHeaders,
        body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        // @ts-expect-error - Bun supports proxy option natively
        proxy: resolvedProxy || undefined,
        // @ts-expect-error - Bun supports duplex for streaming request bodies
        duplex: body instanceof ReadableStream ? "half" : undefined,
      });
    } catch (err) {
      return c.json(
        {
          error: `Request to ${targetUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        502,
      );
    }

    // 8. Capture Set-Cookie headers into cookie jar
    const setCookieHeaders = targetRes.headers.getSetCookie();
    if (setCookieHeaders.length > 0) {
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
    const truncated = responseText.length > MAX_RESPONSE_SIZE;
    const text = truncated ? responseText.slice(0, MAX_RESPONSE_SIZE) : responseText;

    const contentType = targetRes.headers.get("content-type") || "application/octet-stream";
    const responseHeaders: Record<string, string> = { "Content-Type": contentType };
    if (truncated) {
      responseHeaders["X-Truncated"] = "true";
    }

    return c.body(text, targetRes.status, responseHeaders);
  });

  return app;
}
