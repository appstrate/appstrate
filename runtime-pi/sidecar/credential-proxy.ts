// SPDX-License-Identifier: Apache-2.0

/**
 * Shared credential-proxy core.
 *
 * The single code path for all credential-injecting outbound traffic
 * inside the sidecar. {@link executeApiCall} owns the full
 * sequence:
 *
 *   1. Fetch credentials from the platform (per-run Bearer token).
 *   2. Substitute `{{vars}}` into URL / headers / body.
 *   3. Validate the resolved URL against the integration's
 *      `authorizedUris` allowlist + the SSRF blocklist.
 *   4. Inject the credential header server-side.
 *   5. Forward the request to the upstream API.
 *   6. Retry once on 401 with a refreshed token.
 *   7. Log persistent auth failures locally (once per integration per run).
 *
 * The MCP `api_call` tool handler in `runtime-pi/sidecar/mcp.ts`
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
  INTEGRATION_ID_RE,
  type CredentialsResponse,
  type SidecarConfig,
} from "./helpers.ts";
import {
  fetchFollowingRedirectsCapturingCookies,
  mergeSetCookieIntoJar,
  redactHost,
  RedirectBlockedError,
} from "@appstrate/afps-runtime/resolvers";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./logger.ts";

/**
 * Body modes the proxy core accepts. The HTTP handler can produce
 * "none" / "buffered" / "streaming"; the MCP handler produces
 * "buffered" for text + binary uploads, and "formData" for the
 * `{ multipart: [...] }` body shape.
 *
 * The `formData` variant carries a builder closure rather than a
 * pre-baked `FormData` so the per-attempt body can be regenerated with
 * the current credentials — `substituteBody: true` on a string field
 * part must see the refreshed token after a 401-retry, identical to
 * the buffered text path.
 */
type ApiCallRequestBody =
  | { kind: "none" }
  | { kind: "buffered"; bytes: ArrayBuffer; text?: string }
  | { kind: "streaming"; stream: ReadableStream }
  | {
      kind: "formData";
      build: (activeCreds: Record<string, string>) => FormData;
      /**
       * Field-part templates that will undergo `{{var}}` substitution
       * when `substituteBody: true`. Used by the pre-flight check to
       * fail-closed on unresolved placeholders — mirrors the buffered
       * text path. Empty/omitted means no substitution will happen.
       */
      fieldTemplates?: string[];
    };

export interface ApiCallArgs {
  integrationId: string;
  targetUrl: string;
  method: string;
  /** Hop-by-hop and routing headers must already be filtered out. */
  callerHeaders: Record<string, string>;
  body: ApiCallRequestBody;
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
export interface ApiCallSuccess {
  ok: true;
  response: Response;
  /**
   * URL the response was eventually served from after any redirect
   * follow. Equals the resolved target URL when no redirect happened.
   * Propagated to `_meta["dev.appstrate/upstream"].finalUrl` (sanitised
   * for userinfo + fragment) by the MCP handler so agents driving
   * OAuth Authorization Code / CAS / magic-link flows can extract
   * callback query params from the terminal hop.
   */
  finalUrl: string;
  /**
   * `true` when a 401 triggered a credential refresh. On the buffered
   * path the body was replayed and this is a no-op signal (the
   * `response` is from the retried call). On the streaming path the
   * body could not be replayed and the caller must surface the 401
   * with `X-Auth-Refreshed: true` so the agent can retry idempotently.
   */
  authRefreshed: boolean;
}

export interface ApiCallFailure {
  ok: false;
  status: number;
  error: string;
}

export type ApiCallResult = ApiCallSuccess | ApiCallFailure;

/**
 * Tri-state outcome of a credential refresh — mirrors the sidecar source's
 * `RefreshOutcome`. Kept structural (not imported) so the proxy core stays
 * decoupled from the integration source. `"refreshed"` → retry the request;
 * `"terminal"` → credential dead, report + don't retry; `"transient"` →
 * retryable/cooldown, don't retry now and don't flag.
 */
export type CredentialRefreshOutcome = "refreshed" | "terminal" | "transient";

export interface ApiCallDeps {
  config: SidecarConfig;
  cookieJar: Map<string, string[]>;
  fetchFn: typeof fetch;
  fetchCredentials: (integrationId: string) => Promise<CredentialsResponse>;
  refreshCredentials?: (
    integrationId: string,
  ) => Promise<{ response: CredentialsResponse; outcome: CredentialRefreshOutcome }>;
  /**
   * Report a TERMINAL upstream auth failure (a 401 that survived the single
   * refresh+retry) so the platform flags the run's connection for re-connect.
   * Optional — static api_key sources without a platform round-trip omit it.
   */
  reportAuthFailure?: (integrationId: string) => Promise<void>;
  /**
   * Set tracking which integrations already had a persistent auth
   * failure logged in this run. Mutated by the function — shared
   * across calls so a flapping integration only logs once and so the
   * 401-retry path skips the refresh after the first failure.
   */
  reportedAuthFailures: Set<string>;
}

/**
 * Execute an integration call end-to-end: fetch credentials, validate
 * the URL, substitute placeholders, inject the credential header
 * server-side, send the request, retry once on 401, capture cookies,
 * log persistent auth failures. Returns the raw upstream `Response`
 * (body unread) on success, or a structured `{status, error}` failure
 * before any outbound bytes were sent.
 */
export async function executeApiCall(args: ApiCallArgs, deps: ApiCallDeps): Promise<ApiCallResult> {
  const {
    config,
    cookieJar,
    fetchFn,
    fetchCredentials,
    refreshCredentials,
    reportAuthFailure,
    reportedAuthFailures,
  } = deps;
  const { integrationId, targetUrl, method, callerHeaders, body, substituteBody } = args;

  // 1. Validate integrationId format (defence in depth — callers should
  //    have already done this, but cheap to repeat).
  if (!INTEGRATION_ID_RE.test(integrationId)) {
    return { ok: false, status: 400, error: "Invalid X-Integration format" };
  }

  // 2. Fetch credentials.
  let creds: CredentialsResponse;
  try {
    creds = await fetchCredentials(integrationId);
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
        error: `URL not authorized for integration "${integrationId}". Allowed: ${creds.authorizedUris.join(", ")}`,
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

  // 6. Pre-check body placeholder resolution (buffered text + multipart
  //    field-parts under substituteBody). Streaming + binary buffered
  //    bodies are pass-through.
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
  if (substituteBody && body.kind === "formData" && body.fieldTemplates?.length) {
    const unresolved = new Set<string>();
    for (const template of body.fieldTemplates) {
      for (const v of findUnresolvedPlaceholders(substituteVars(template, creds.credentials))) {
        unresolved.add(v);
      }
    }
    if (unresolved.size) {
      return {
        ok: false,
        status: 400,
        error: `Unresolved placeholders in body: {{${[...unresolved].join()}}}`,
      };
    }
  }

  /** Build the request body with credential substitution applied. */
  const buildBody = (
    activeCreds: Record<string, string>,
  ): ArrayBuffer | string | ReadableStream | FormData | undefined => {
    if (body.kind === "none") return undefined;
    if (body.kind === "streaming") return body.stream;
    if (body.kind === "formData") return body.build(activeCreds);
    if (substituteBody && body.text !== undefined) {
      return substituteVars(body.text, activeCreds);
    }
    return body.bytes;
  };

  /**
   * One outbound attempt. Re-runs header + body substitution against
   * the supplied creds so 401-retry sees the refreshed token. Returns
   * both the upstream `Response` and the URL it was served from — the
   * streaming path reads it off `Response.url` (Bun populates this
   * after native redirect:"follow"), the manual-follow path threads
   * the terminal-hop URL through the loop.
   */
  const doUpstreamRequest = async (
    activeCreds: CredentialsResponse,
  ): Promise<{ response: Response; finalUrl: string }> => {
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(callerHeaders)) {
      resolvedHeaders[key] = substituteVars(value, activeCreds.credentials);
    }
    // Server-side credential injection (Authorization, X-Api-Key, …).
    applyInjectedCredentialHeader(resolvedHeaders, activeCreds);
    normalizeAuthScheme(resolvedHeaders);
    // Re-inject sticky cookies for the integration.
    const storedCookies = cookieJar.get(integrationId);
    if (storedCookies && storedCookies.length) {
      const existing = resolvedHeaders["cookie"] || "";
      resolvedHeaders["cookie"] = existing
        ? `${existing}; ${storedCookies.join("; ")}`
        : storedCookies.join("; ");
    }

    // For the FormData body shape, drop any caller-supplied
    // multipart Content-Type so Bun's fetch generates the right
    // `boundary=…` token itself — supplying a stale boundary would
    // produce a wire-broken request.
    if (body.kind === "formData") {
      for (const key of Object.keys(resolvedHeaders)) {
        if (
          key.toLowerCase() === "content-type" &&
          /^multipart\//i.test(resolvedHeaders[key] ?? "")
        ) {
          delete resolvedHeaders[key];
        }
      }
    }

    const init: RequestInit & Record<string, unknown> = {
      method,
      headers: resolvedHeaders,
      body: buildBody(activeCreds.credentials),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      proxy: args.proxyUrl || undefined,
    };
    if (init.body instanceof ReadableStream) {
      // Streaming bodies can't be replayed across hops, so the manual
      // redirect follower (which re-issues each hop) can't run here.
      // `redirect: "manual"` is mandatory, NOT a default: native
      // `redirect: "follow"` would carry the injected credential header
      // (and any cookie jar) into an upstream-controlled cross-origin
      // redirect — WHATWG fetch strips `Authorization` cross-origin but
      // NOT custom headers like `X-Api-Key`, the usual injection target.
      // Returning the 30x unfollowed keeps the credential on the initial
      // (allowlist-checked) origin only; the caller re-issues against the
      // surfaced `finalUrl` if it wants to follow.
      init.duplex = "half";
      init.redirect = "manual";
      const response = await fetchFn(resolvedUrl, init);
      return { response, finalUrl: response.url || resolvedUrl };
    }
    return fetchFollowingRedirectsCapturingCookies({
      url: resolvedUrl,
      init,
      fetchFn,
      cookieJar,
      integrationId,
      injectedCredentialHeader: activeCreds.credentialHeaderName?.toLowerCase() ?? null,
      authorizedUris: creds.authorizedUris ?? undefined,
      allowAllUris: creds.allowAllUris,
      // Preserve the sidecar's structured per-hop refusal logging.
      logger,
    });
  };

  // 7. First outbound request. Network/timeout errors surface as a
  //    structured failure rather than a raw exception.
  let upstream: Response;
  let upstreamFinalUrl: string = resolvedUrl;
  try {
    const r = await doUpstreamRequest(creds);
    upstream = r.response;
    upstreamFinalUrl = r.finalUrl;
  } catch (err) {
    return wrapRequestError(err, resolvedUrl);
  }

  let authRefreshed = false;
  // Outcome of the refresh attempt below (null = no attempt made). Drives the
  // terminal-failure report: a `"transient"` refresh (network/5xx/cooldown)
  // must NOT flag the connection — only a genuine dead credential should.
  let refreshOutcome: CredentialRefreshOutcome | null = null;

  // 7b. Retry on 401 — refresh credentials, re-issue the call. Only
  //     possible on the buffered path (streaming bodies are consumed
  //     once and cannot be replayed).
  if (
    upstream.status === 401 &&
    refreshCredentials &&
    config.platformApiUrl &&
    config.runToken &&
    !reportedAuthFailures.has(integrationId)
  ) {
    try {
      const refreshed = await refreshCredentials(integrationId);
      refreshOutcome = refreshed.outcome;
      // Retry ONLY on a genuine token rotation. A `"terminal"` (dead
      // credential) or `"transient"` (retryable) outcome means re-issuing the
      // request would just 401 again with the same/absent token — skip it.
      if (refreshed.outcome === "refreshed") {
        if (body.kind !== "streaming") {
          try {
            const r = await doUpstreamRequest(refreshed.response);
            upstream = r.response;
            upstreamFinalUrl = r.finalUrl;
          } catch (err) {
            return wrapRequestError(err, resolvedUrl);
          }
        } else {
          // Body already consumed — surface the rotated-but-still-401
          // signal to the caller, which adds X-Auth-Refreshed.
          authRefreshed = true;
        }
      }
    } catch {
      // Refresh callback itself threw — treat as transient (do not flag).
      refreshOutcome = "transient";
    }
  }

  // 8. Terminal-hop Set-Cookie capture. No-op for buffered (the
  //    follower already merged every hop); load-bearing for streaming
  //    (final hop only — bodies can't be replayed).
  mergeSetCookieIntoJar(upstream.headers.getSetCookie(), cookieJar, integrationId);

  // 9. Persistent auth failure (once per integration per run). A 401 that
  //    survived the refresh+retry means the credential is terminally dead:
  //    report it to the platform so the connection is flagged for re-connect
  //    (next-launch readiness gate + live dashboard badge) — UNLESS the refresh
  //    was `"transient"` (network/5xx/cooldown), in which case the credential
  //    may still be valid and flagging would be a false positive. Only 401
  //    (authentication failed) triggers the report; a 403 is an authorization
  //    decision, not a dead credential. The Set also gates the 401-retry path
  //    above so a dead credential triggers at most one refresh attempt.
  if (upstream.status === 401 && !reportedAuthFailures.has(integrationId)) {
    reportedAuthFailures.add(integrationId);
    if (refreshOutcome !== "transient" && reportAuthFailure) {
      await reportAuthFailure(integrationId).catch(() => undefined);
    }
    logger.warn("Upstream returned 401 after retry", { integrationId, refreshOutcome });
  }

  return { ok: true, response: upstream, finalUrl: upstreamFinalUrl, authRefreshed };
}

function wrapFetchError(err: unknown, label: string, url: string): ApiCallFailure {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  let domain: string | undefined;
  try {
    domain = new URL(url).hostname;
  } catch {}
  const suffix = code ? `: ${code}` : "";
  const domainHint = domain ? ` (${domain})` : "";
  return { ok: false, status: 502, error: `${label}${suffix}${domainHint}` };
}

/**
 * Demultiplex outbound-request errors into structured failures:
 *
 *   - {@link RedirectBlockedError} → 403 (upstream tried to pivot to
 *     a non-allowlisted or SSRF-blocked host — this is a policy
 *     decision, not a network fault).
 *   - everything else (timeout, ECONNREFUSED, ENOTFOUND) → 502 via
 *     {@link wrapFetchError}.
 *
 * Redacts the target host into the error message; the full URL stays
 * out because a redirect target may itself encode capabilities
 * (`?token=…`) we don't want surfaced to the agent.
 */
function wrapRequestError(err: unknown, resolvedUrl: string): ApiCallFailure {
  if (err instanceof RedirectBlockedError) {
    return {
      ok: false,
      status: 403,
      error: `Redirect blocked (${err.reason}): host=${redactHost(err.hopUrl)}`,
    };
  }
  return wrapFetchError(err, "Upstream request failed", resolvedUrl);
}
