import { Hono } from "hono";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://host.docker.internal:3000";
const EXECUTION_TOKEN = process.env.EXECUTION_TOKEN || "";
const PROXY_URL = process.env.PROXY_URL || "";
const MAX_RESPONSE_SIZE = 50_000;
const OUTBOUND_TIMEOUT_MS = 30_000;
const SERVICE_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// In-memory cookie jar keyed by serviceId. Ephemeral — lives only for this execution.
const cookieJar = new Map<string, string[]>();

const app = new Hono();

// --- Helpers ---

interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
}

async function fetchCredentials(serviceId: string): Promise<CredentialsResponse> {
  const res = await fetch(`${PLATFORM_API_URL}/internal/credentials/${serviceId}`, {
    headers: { Authorization: `Bearer ${EXECUTION_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch credentials for ${serviceId}: ${res.status}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

function substituteVars(text: string, credentials: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => credentials[key] ?? _match);
}

function findUnresolvedPlaceholders(text: string): string[] {
  const matches = [...text.matchAll(/\{\{(\w+)\}\}/g)];
  return matches.map((m) => m[1]!);
}

function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}

/**
 * Block requests to private/internal networks when no authorizedUris are defined.
 * Prevents SSRF to cloud metadata services, localhost, and internal IPs.
 */
function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URL = blocked
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block non-HTTPS schemes (except http for known public APIs)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return true;
  }

  // Block localhost and loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  // Block internal Docker hostnames
  if (hostname === "sidecar" || hostname === "agent" || hostname === "host.docker.internal") {
    return true;
  }

  // Block cloud metadata service
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
    return true;
  }

  // Block private IP ranges (RFC 1918 + link-local)
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipv4Match) {
    const [, first, second] = ipv4Match;
    const a = parseInt(first!, 10);
    const b = parseInt(second!, 10);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
  }

  return false;
}

// --- Routes ---

// Health check for startup readiness
app.get("/health", (c) => c.json({ status: "ok" }));

// Execution history proxy
app.get("/execution-history", async (c) => {
  const qs = c.req.url.split("?")[1] || "";
  const url = `${PLATFORM_API_URL}/internal/execution-history${qs ? `?${qs}` : ""}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${EXECUTION_TOKEN}` },
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
  const serviceId = c.req.header("X-Service");
  const targetUrl = c.req.header("X-Target");
  const substituteBody = c.req.header("X-Substitute-Body");
  const proxyHeader = c.req.header("X-Proxy");

  if (!serviceId) {
    return c.json({ error: "Missing X-Service header" }, 400);
  }
  if (!targetUrl) {
    return c.json({ error: "Missing X-Target header" }, 400);
  }

  // 1b. Validate serviceId format (prevent path traversal)
  if (!SERVICE_ID_RE.test(serviceId)) {
    return c.json({ error: "Invalid X-Service format" }, 400);
  }

  // 2. Fetch credentials
  let creds: CredentialsResponse;
  try {
    creds = await fetchCredentials(serviceId);
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
    const available = Object.keys(creds.credentials);
    return c.json(
      {
        error: `Unresolved placeholders in URL: {{${unresolvedInUrl.join()}}}. Available: ${available.join(", ") || "(none)"}`,
      },
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
          error: `URL not authorized for service "${serviceId}". Allowed: ${creds.authorizedUris.join(", ")}`,
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
      lower === "x-service" ||
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
    || PROXY_URL
    || "";

  if (resolvedProxy) {
    const unresolvedInProxy = findUnresolvedPlaceholders(resolvedProxy);
    if (unresolvedInProxy.length > 0) {
      const available = Object.keys(creds.credentials);
      return c.json(
        {
          error: `Unresolved placeholders in X-Proxy: {{${unresolvedInProxy.join()}}}. Available: ${available.join(", ") || "(none)"}`,
        },
        400,
      );
    }
  }

  // 5b. Check for unresolved placeholders in headers
  for (const [key, value] of Object.entries(forwardedHeaders)) {
    const unresolved = findUnresolvedPlaceholders(value);
    if (unresolved.length > 0) {
      const available = Object.keys(creds.credentials);
      return c.json(
        {
          error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}. Available: ${available.join(", ") || "(none)"}`,
        },
        400,
      );
    }
  }

  // 5c. Inject stored cookies from cookie jar
  const storedCookies = cookieJar.get(serviceId);
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
      // Buffer body and substitute variables
      const rawBody = await c.req.text();
      body = substituteVars(rawBody, creds.credentials);
      // Check for unresolved placeholders in body
      const unresolvedInBody = findUnresolvedPlaceholders(body);
      if (unresolvedInBody.length > 0) {
        const available = Object.keys(creds.credentials);
        return c.json(
          {
            error: `Unresolved placeholders in body: {{${unresolvedInBody.join()}}}. Available: ${available.join(", ") || "(none)"}`,
          },
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
    targetRes = await fetch(resolvedUrl, {
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
    const existing = cookieJar.get(serviceId) ?? [];
    const byName = new Map<string, string>();
    for (const c of existing) {
      const name = c.split("=")[0]!;
      byName.set(name, c);
    }
    for (const c of cookieValues) {
      const name = c.split("=")[0]!;
      byName.set(name, c);
    }
    cookieJar.set(serviceId, [...byName.values()]);
  }

  // 9. Return response as JSON envelope
  const responseText = await targetRes.text();
  const truncated = responseText.length > MAX_RESPONSE_SIZE;
  const text = truncated ? responseText.slice(0, MAX_RESPONSE_SIZE) : responseText;

  // Parse JSON bodies so agents don't need to double-parse
  const contentType = targetRes.headers.get("content-type") || "";
  let responseBody: unknown = text;
  if (/\bjson\b/.test(contentType) && !truncated) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      // Content-Type says JSON but body isn't valid — keep as string
    }
  }

  return c.json({
    status: targetRes.status,
    statusText: targetRes.statusText,
    body: responseBody,
    ...(truncated ? { truncated: true } : {}),
  });
});

// --- Start ---

const port = parseInt(process.env.PORT || "8080", 10);
console.log(`Sidecar proxy listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};
