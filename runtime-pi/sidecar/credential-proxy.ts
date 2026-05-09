// SPDX-License-Identifier: Apache-2.0

/**
 * Shared credential-proxy core.
 *
 * The single code path for all credential-injecting outbound traffic
 * inside the sidecar. {@link executeProviderCall} owns the full
 * sequence:
 *
 *   1. Fetch credentials from the platform (per-run Bearer token).
 *   2. Substitute `{{vars}}` into URL / headers / body.
 *   3. Validate the resolved URL against the provider's
 *      `authorizedUris` allowlist + the SSRF blocklist.
 *   4. Inject the credential header server-side.
 *   5. Forward the request to the upstream API.
 *   6. Retry once on 401 with a refreshed token.
 *   7. Log persistent auth failures locally (once per provider per run).
 *
 * The MCP `provider_call` tool handler in `runtime-pi/sidecar/mcp.ts`
 * takes typed JSON-RPC arguments and calls this helper directly, then
 * hands the resulting upstream `Response` to `responseToToolResult` for
 * blob spillover / truncation.
 *
 * What this module deliberately does NOT do:
 *   - Truncate response bodies. The MCP handler spills oversized or
 *     binary responses to the BlobStore as `resource_link` blocks.
 *   - Cache credentials. Each call fetches fresh from the platform —
 *     the platform owns the TTL.
 */

import {
  applyInjectedCredentialHeader,
  isBlockedUrl,
  matchesAuthorizedUri,
  normalizeAuthScheme,
  substituteVars,
  findUnresolvedPlaceholders,
  OUTBOUND_TIMEOUT_MS,
  PROVIDER_ID_RE,
  type CredentialsResponse,
  type SidecarConfig,
} from "./helpers.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./logger.ts";

/**
 * Body modes the proxy core accepts. The HTTP handler can produce
 * any of the three; the MCP handler only ever produces "buffered"
 * (since JSON-RPC carries body as a string).
 */
export type ProviderRequestBody =
  | { kind: "none" }
  | { kind: "buffered"; bytes: ArrayBuffer; text?: string }
  | { kind: "streaming"; stream: ReadableStream };

export interface ProviderCallArgs {
  providerId: string;
  targetUrl: string;
  method: string;
  /** Hop-by-hop and routing headers must already be filtered out. */
  callerHeaders: Record<string, string>;
  body: ProviderRequestBody;
  /** When true, substitute `{{credential}}` placeholders inside the body. */
  substituteBody?: boolean;
  /** Outbound HTTP proxy URL — empty string disables. */
  proxyUrl?: string;
}

/**
 * Result of a successful proxy call. The upstream response body has
 * NOT been read yet — the caller decides whether to buffer (HTTP
 * handler with truncation) or pass through (MCP `responseToToolResult`).
 */
export interface ProviderCallSuccess {
  ok: true;
  response: Response;
  /**
   * `true` when a 401 triggered a credential refresh. On the buffered
   * path the body was replayed and this is a no-op signal (the
   * `response` is from the retried call). On the streaming path the
   * body could not be replayed and the caller must surface the 401
   * with `X-Auth-Refreshed: true` so the agent can retry idempotently.
   */
  authRefreshed: boolean;
}

export interface ProviderCallFailure {
  ok: false;
  status: number;
  error: string;
}

export type ProviderCallResult = ProviderCallSuccess | ProviderCallFailure;

export interface ProviderCallDeps {
  config: SidecarConfig;
  cookieJar: Map<string, string[]>;
  fetchFn: typeof fetch;
  fetchCredentials: (providerId: string) => Promise<CredentialsResponse>;
  refreshCredentials?: (providerId: string) => Promise<CredentialsResponse>;
  /**
   * Set tracking which providers already had a persistent auth
   * failure logged in this run. Mutated by the function — shared
   * across calls so a flapping provider only logs once and so the
   * 401-retry path skips the refresh after the first failure.
   */
  reportedAuthFailures: Set<string>;
}

/**
 * Execute a provider call end-to-end: fetch credentials, validate
 * the URL, substitute placeholders, inject the credential header
 * server-side, send the request, retry once on 401, capture cookies,
 * log persistent auth failures. Returns the raw upstream `Response`
 * (body unread) on success, or a structured `{status, error}` failure
 * before any outbound bytes were sent.
 */
export async function executeProviderCall(
  args: ProviderCallArgs,
  deps: ProviderCallDeps,
): Promise<ProviderCallResult> {
  const { config, cookieJar, fetchFn, fetchCredentials, refreshCredentials, reportedAuthFailures } =
    deps;
  const { providerId, targetUrl, method, callerHeaders, body, substituteBody } = args;

  // 1. Validate providerId format (defence in depth — callers should
  //    have already done this, but cheap to repeat).
  if (!PROVIDER_ID_RE.test(providerId)) {
    return { ok: false, status: 400, error: "Invalid X-Provider format" };
  }

  // 2. Fetch credentials.
  let creds: CredentialsResponse;
  try {
    creds = await fetchCredentials(providerId);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Credential fetch failed: ${getErrorMessage(err)}`,
    };
  }

  // 3. Substitute {{vars}} in target URL.
  const resolvedUrl = substituteVars(targetUrl, creds.credentials);
  const unresolvedInUrl = findUnresolvedPlaceholders(resolvedUrl);
  if (unresolvedInUrl.length) {
    return {
      ok: false,
      status: 400,
      error: `Unresolved placeholders in URL: {{${unresolvedInUrl.join()}}}`,
    };
  }

  // 4. Validate URL against authorizedUris (or block internal
  //    targets when allowAllUris is set).
  if (creds.allowAllUris) {
    if (isBlockedUrl(resolvedUrl)) {
      return { ok: false, status: 403, error: "URL targets a blocked network range" };
    }
  } else if (creds.authorizedUris && creds.authorizedUris.length) {
    if (!matchesAuthorizedUri(resolvedUrl, creds.authorizedUris)) {
      return {
        ok: false,
        status: 403,
        error: `URL not authorized for provider "${providerId}". Allowed: ${creds.authorizedUris.join(", ")}`,
      };
    }
  } else {
    // No authorizedUris and no allowAllUris — apply the SSRF safety net.
    if (isBlockedUrl(resolvedUrl)) {
      return { ok: false, status: 403, error: "URL targets a blocked network range" };
    }
  }

  // 5b. Pre-substitute headers with the *initial* creds so we can
  //     fail fast on unresolved placeholders. Re-substituted on each
  //     `doUpstreamRequest` so a 401 retry sees the refreshed token.
  for (const [key, rawValue] of Object.entries(callerHeaders)) {
    const resolved = substituteVars(rawValue, creds.credentials);
    const unresolved = findUnresolvedPlaceholders(resolved);
    if (unresolved.length) {
      return {
        ok: false,
        status: 400,
        error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}`,
      };
    }
  }

  // 6. Pre-check body placeholder resolution (buffered + substitute path only).
  if (substituteBody && body.kind === "buffered" && body.text !== undefined) {
    const testBody = substituteVars(body.text, creds.credentials);
    const unresolvedInBody = findUnresolvedPlaceholders(testBody);
    if (unresolvedInBody.length) {
      return {
        ok: false,
        status: 400,
        error: `Unresolved placeholders in body: {{${unresolvedInBody.join()}}}`,
      };
    }
  }

  /** Build the request body with credential substitution applied. */
  const buildBody = (
    activeCreds: Record<string, string>,
  ): ArrayBuffer | string | ReadableStream | undefined => {
    if (body.kind === "none") return undefined;
    if (body.kind === "streaming") return body.stream;
    if (substituteBody && body.text !== undefined) {
      return substituteVars(body.text, activeCreds);
    }
    return body.bytes;
  };

  /**
   * One outbound attempt. Re-runs header + body substitution against
   * the supplied creds so 401-retry sees the refreshed token.
   */
  const doUpstreamRequest = async (activeCreds: CredentialsResponse): Promise<Response> => {
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(callerHeaders)) {
      resolvedHeaders[key] = substituteVars(value, activeCreds.credentials);
    }
    // Server-side credential injection (Authorization, X-Api-Key, …).
    applyInjectedCredentialHeader(resolvedHeaders, activeCreds);
    normalizeAuthScheme(resolvedHeaders);
    // Re-inject sticky cookies for the provider.
    const storedCookies = cookieJar.get(providerId);
    if (storedCookies && storedCookies.length) {
      const existing = resolvedHeaders["cookie"] || "";
      resolvedHeaders["cookie"] = existing
        ? `${existing}; ${storedCookies.join("; ")}`
        : storedCookies.join("; ");
    }

    const init: RequestInit & Record<string, unknown> = {
      method,
      headers: resolvedHeaders,
      body: buildBody(activeCreds.credentials),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      proxy: args.proxyUrl || undefined,
    };
    if (init.body instanceof ReadableStream) {
      // Required by fetch when sending a streaming request body.
      init.duplex = "half";
    }
    return fetchFn(resolvedUrl, init);
  };

  // 7. First outbound request. Network/timeout errors surface as a
  //    structured failure rather than a raw exception.
  let upstream: Response;
  try {
    upstream = await doUpstreamRequest(creds);
  } catch (err) {
    return wrapFetchError(err, "Upstream request failed", resolvedUrl);
  }

  let authRefreshed = false;

  // 7b. Retry on 401 — refresh credentials, re-issue the call. Only
  //     possible on the buffered path (streaming bodies are consumed
  //     once and cannot be replayed).
  if (
    upstream.status === 401 &&
    refreshCredentials &&
    config.platformApiUrl &&
    config.runToken &&
    !reportedAuthFailures.has(providerId)
  ) {
    try {
      const refreshed = await refreshCredentials(providerId);
      if (body.kind !== "streaming") {
        try {
          upstream = await doUpstreamRequest(refreshed);
        } catch (err) {
          return wrapFetchError(err, "Upstream request failed", resolvedUrl);
        }
      } else {
        // Body already consumed — surface the rotated-but-still-401
        // signal to the caller, which adds X-Auth-Refreshed.
        authRefreshed = true;
      }
    } catch {
      // Refresh itself failed (invalid_grant, revoked token).
    }
  }

  // 8. Capture Set-Cookie headers into the per-provider jar. We strip
  //    attributes (Path, Expires, …) and merge by name so cookies
  //    rotated by upstream replace the prior value.
  const setCookieHeaders = upstream.headers.getSetCookie();
  if (setCookieHeaders.length) {
    const cookieValues = setCookieHeaders.map((h) => h.split(";")[0]!.trim());
    const existing = cookieJar.get(providerId) ?? [];
    const byName = new Map<string, string>();
    for (const ck of existing) byName.set(ck.split("=")[0]!, ck);
    for (const ck of cookieValues) byName.set(ck.split("=")[0]!, ck);
    cookieJar.set(providerId, [...byName.values()]);
  }

  // 9. Log persistent auth failures locally (once per provider per
  //    run, only if the retry above did NOT fix it). The Set also
  //    gates the 401-retry path above so a dead credential triggers
  //    at most one refresh attempt per provider.
  if (upstream.status === 401 && !reportedAuthFailures.has(providerId)) {
    reportedAuthFailures.add(providerId);
    logger.warn("Upstream returned 401 after retry", { providerId });
  }

  return { ok: true, response: upstream, authRefreshed };
}

function wrapFetchError(err: unknown, label: string, url: string): ProviderCallFailure {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  let domain: string | undefined;
  try {
    domain = new URL(url).hostname;
  } catch {}
  const suffix = code ? `: ${code}` : "";
  const domainHint = domain ? ` (${domain})` : "";
  return { ok: false, status: 502, error: `${label}${suffix}${domainHint}` };
}
