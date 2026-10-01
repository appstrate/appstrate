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
 *   3. Refuse a credential the allowlist does not bound (`credentialUrlPolicy`).
 *   4. Inject the credential header server-side.
 *   5. Send it through `fetchApiCall`, the outbound engine shared with the platform and CLI.
 *   6. Retry once on 401 with a refreshed token.
 *   7. Log persistent auth failures locally (once per connection per run).
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
  credentialCarryingHeader,
  normalizeAuthSchemeTemplates,
  substituteVars,
  INTEGRATION_ID_RE,
  type CredentialsResponse,
  type HostResolver,
  type SidecarConfig,
} from "./helpers.ts";
import {
  classifyApiCallFailure,
  cookieScope,
  credentialUrlPolicy,
  fetchApiCall,
  redactionFields,
  redactCredentialHost,
  templateHost,
  unresolvedPlaceholders,
  urlPolicyRefusalMessage,
  type CookieJar,
} from "@appstrate/afps-runtime/resolvers";
import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { buildInjectedCredentialHeader } from "@appstrate/connect/proxy-primitives";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./logger.ts";
import { filterSensitiveHeaders } from "./redact.ts";

/**
 * Body modes the proxy core accepts. The HTTP handler can produce
 * "none" / "buffered" / "streaming"; the MCP handler produces
 * "buffered" for text + binary uploads, "formData" for the
 * `{ multipart: [...] }` body shape, and "json" for a plain JSON
 * object/array (serialized here, after leaf substitution).
 *
 * The `formData` variant carries a builder closure rather than a
 * pre-baked `FormData` so the per-attempt body can be regenerated with
 * the current credentials — `substituteBody: true` on a string field
 * part must see the refreshed token after a 401-retry, identical to
 * the buffered text path.
 */
export type ApiCallRequestBody =
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
    }
  | {
      /**
       * A plain JSON object/array body. Serialization is DEFERRED to the
       * proxy (like `formData`) so that `{{var}}` substitution happens on
       * the structured leaf values BEFORE `JSON.stringify` — the serializer
       * then escapes every value, so an injected credential containing `"`
       * or `\` can never produce malformed JSON on the wire. Re-serialized
       * per attempt so a 401-retry sees refreshed credentials.
       */
      kind: "json";
      value: unknown;
    };

interface ApiCallArgs {
  integrationId: string;
  connectionId: string;
  targetUrl: string;
  method: string;
  /** Sidecar-control headers already dropped; `fetchApiCall` drops Host, hop-by-hop and framing. */
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
interface ApiCallSuccess {
  ok: true;
  response: Response;
  /**
   * URL the response was eventually served from after any redirect
   * follow. Equals the resolved target URL when no redirect happened.
   *
   * An OUTPUT, never an input. `doUpstreamRequest` closes over the
   * resolved target URL and issues against THAT on both branches — its
   * only parameter is the credential set — so the 401 replay re-issues
   * against the resolved target and re-follows the chain from scratch,
   * then overwrites this value with the replay's own terminus.
   *
   * All three readers live in this module and it has no consumer
   * outside it: the manual follower returns it as the chain terminus,
   * and the debug envelope reports it as `host` (redacted) and as
   * `redirected` (`!== resolvedUrl`).
   *
   * It is NOT projected onto `_meta` either. That projection existed for
   * #471 and was removed with `UpstreamMeta.finalUrl`; the agent-side
   * parser (`runtime-pi/mcp/upstream-meta.ts` — alive, and required on
   * `api_upload`, which calls it uncaught; `api_call` wraps it in
   * `safeStatus`, which falls back to `null`) reads `{ status, headers }`
   * only. Nothing on `_meta` is agent-visible in any case: see the
   * `redirect: "manual"` comment in `doUpstreamRequest` below.
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

interface ApiCallFailure {
  ok: false;
  status: number;
  error: string;
}

type ApiCallResult = ApiCallSuccess | ApiCallFailure;

/**
 * The integration-agnostic half of {@link ApiCallDeps}: everything the
 * credential-proxy core needs that is scoped to the RUN rather than to one
 * integration. Built once per sidecar (`buildSidecarRuntimeDeps`) and shared;
 * the credential pair is layered on per bound connection at tool-build time.
 */
export interface ApiCallBaseDeps {
  config: SidecarConfig;
  /** Run-wide sticky-cookie store, read and written through `cookieScope`. */
  cookieJar: CookieJar;
  /** Transport override (tests); disables the address pin of `api_call` upstreams. */
  fetchFn?: typeof fetch;
  /**
   * Set tracking which credential scopes already had a persistent auth
   * failure logged in this run. Mutated by the function — shared
   * across calls so a flapping connection only logs once and so the
   * 401-retry path skips the refresh after the first failure.
   */
  reportedAuthFailures: Set<string>;
  /**
   * DNS resolver for the SSRF rebind check — injectable for tests.
   * Production callers omit it (system resolver via `node:dns`).
   */
  resolveHost?: HostResolver;
}

export interface ApiCallDeps extends ApiCallBaseDeps {
  /**
   * The manifest's declared (unrendered) `authorized_uris`. Matching uses the connection's
   * rendered `CredentialsResponse.authorizedUris`; only a host written literally HERE pins the
   * SSRF gate or shares cookies, so a connection-supplied host never does.
   */
  declaredUris: readonly string[];
  fetchCredentials: (integrationId: string) => Promise<CredentialsResponse>;
  /**
   * Force a refresh on a mid-run 401. Resolves to the fresh credentials when
   * the token was actually rotated (the caller replays the request once), or
   * `null` when it was not — on a terminal failure the platform `/refresh`
   * already flagged the connection `needsReconnection`, so the caller must NOT
   * retry with a stale token.
   */
  refreshCredentials?: (
    integrationId: string,
    rejected: CredentialsResponse,
  ) => Promise<CredentialsResponse | null>;
  /** A 2xx on the injected credential — ends a pending rejection streak on the connection. */
  reportUpstreamSuccess?: (answered: CredentialsResponse) => void;
}

/**
 * Recursively apply `{{var}}` substitution to the string leaves of a
 * JSON value, returning a NEW value (input untouched). When `creds` is
 * undefined the value is returned structurally unchanged (no
 * substitution requested). Substituting on the structured leaves — then
 * letting `JSON.stringify` escape — is what makes the `json` body shape
 * injection-safe: a credential containing `"`/`\`/newline is escaped by
 * the serializer instead of corrupting the surrounding JSON.
 */
function deepSubstituteJson(value: unknown, creds: Record<string, string> | undefined): unknown {
  if (typeof value === "string") return creds ? substituteVars(value, creds) : value;
  if (Array.isArray(value)) return value.map((v) => deepSubstituteJson(v, creds));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepSubstituteJson(v, creds);
    return out;
  }
  return value;
}

/** The string leaves of a JSON value: what {@link deepSubstituteJson} substitutes. */
function* jsonStringLeaves(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* jsonStringLeaves(v);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) yield* jsonStringLeaves(v);
  }
}

/** Exhaustiveness guard: a new body kind without a buildBody case fails to compile here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled request-body kind: ${JSON.stringify(value)}`);
}

/**
 * Per-connection key of the cookie jar and the 401 verdicts (`reportedAuthFailures`): two
 * connections of one integration never share a cookie nor a persistent-401 verdict. NUL occurs
 * in neither a package id (`INTEGRATION_ID_RE`) nor a connection uuid, so the two parts are
 * unambiguous and no integration id can be crafted to forge another's scope.
 */
export function credentialScope(integrationId: string, connectionId: string): string {
  return `${integrationId}\u0000${connectionId}`;
}

/** Strings substituted in a `substituteBody: true` body (JSON escaping would hide `{{\tkey}}`). */
function substitutedBodyStrings(body: ApiCallRequestBody): Iterable<string> {
  switch (body.kind) {
    case "none":
    case "streaming":
      // Pass-through by design — no substitution ever happens on these kinds.
      return [];
    case "buffered":
      return body.text !== undefined ? [body.text] : [];
    case "formData":
      return body.fieldTemplates ?? [];
    case "json":
      return jsonStringLeaves(body.value);
    default:
      return assertNever(body);
  }
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
  const { config, cookieJar, fetchFn, fetchCredentials, refreshCredentials, reportedAuthFailures } =
    deps;
  const { integrationId, targetUrl, method, body, substituteBody } = args;
  const scope = credentialScope(integrationId, args.connectionId);

  // Repair `Bearer{{token}}` → `Bearer {{token}}` on the caller TEMPLATES,
  // once, before any substitution runs. Doing it on the resolved value (what
  // this used to do, #988) corrupted every raw secret whose first bytes spell
  // a scheme name. Every downstream read — the credential-reference scan, the
  // fail-fast placeholder pre-check, and each `doUpstreamRequest` attempt —
  // goes through this repaired copy so they can never disagree.
  const callerHeaders = normalizeAuthSchemeTemplates(args.callerHeaders);

  // 1. Validate integrationId format (defence in depth — callers should
  //    have already done this, but cheap to repeat).
  if (!INTEGRATION_ID_RE.test(integrationId)) {
    return { ok: false, status: 400, error: "Invalid integration id" };
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
  const unresolvedInUrl = unresolvedPlaceholders(targetUrl, creds.credentials);
  if (unresolvedInUrl.length) {
    return {
      ok: false,
      status: 400,
      error: `Unresolved placeholders in URL: {{${unresolvedInUrl.join()}}}`,
    };
  }

  // 4. URL policy (docs/architecture/SIDECAR.md); the per-hop gate runs inside `fetchApiCall`.
  const authorizedUris = creds.authorizedUris ?? [];
  const policy = credentialUrlPolicy({
    templates: [
      targetUrl,
      ...Object.values(callerHeaders),
      ...(substituteBody ? substitutedBodyStrings(body) : []),
    ],
    fields: creds.credentials,
    allowAllUris: creds.allowAllUris,
    declaredUris: deps.declaredUris,
    authorizedUris,
    injectsCredential: buildInjectedCredentialHeader(creds) !== undefined,
  });
  if (policy.refuse) {
    return { ok: false, status: 403, error: urlPolicyRefusalMessage(policy.refuse, integrationId) };
  }
  // Reassigned when a 401 retry runs with refreshed credentials.
  let redactFields = redactionFields(policy, creds.credentials);
  const targetHost = templateHost(targetUrl);

  // 4b. This call's view of the run-wide jar (docs/architecture/SIDECAR.md), keyed by the
  //     connection's credential scope. Siblings are gated per URL, whatever gated the initial target.
  const cookies = cookieScope(cookieJar, scope, policy.allowAllUris ? null : deps.declaredUris);

  // 5b. Fail fast on the caller's headers; each `doUpstreamRequest` substitutes them, so a 401
  //     retry sees the refreshed token.
  for (const [key, rawValue] of Object.entries(callerHeaders)) {
    // The caller's own value; one a credential makes invalid is the engine's `invalid_header`.
    if (!isHttpFieldValue(rawValue)) {
      return { ok: false, status: 400, error: `Header "${key}" is not a valid HTTP field value` };
    }
    const unresolved = unresolvedPlaceholders(rawValue, creds.credentials);
    if (unresolved.length) {
      return {
        ok: false,
        status: 400,
        error: `Unresolved placeholders in header "${key}": {{${unresolved.join()}}}`,
      };
    }
  }

  // 6. The same on every string the body substitutes (text, multipart fields, JSON leaves).
  if (substituteBody) {
    const unresolvedInBody = new Set<string>();
    for (const template of substitutedBodyStrings(body)) {
      for (const key of unresolvedPlaceholders(template, creds.credentials)) {
        unresolvedInBody.add(key);
      }
    }
    if (unresolvedInBody.size) {
      return {
        ok: false,
        status: 400,
        error: `Unresolved placeholders in body: {{${[...unresolvedInBody].join()}}}`,
      };
    }
  }

  /** Build the request body with credential substitution applied. */
  const buildBody = (
    activeCreds: Record<string, string>,
  ): ArrayBuffer | string | ReadableStream | FormData | undefined => {
    switch (body.kind) {
      case "none":
        return undefined;
      case "streaming":
        return body.stream;
      case "formData":
        return body.build(activeCreds);
      case "json":
        // Substitute on the structured leaves first, THEN serialize so
        // every value is escaped by `JSON.stringify` (injection-safe).
        return JSON.stringify(
          deepSubstituteJson(body.value, substituteBody ? activeCreds : undefined),
        );
      case "buffered":
        return substituteBody && body.text !== undefined
          ? substituteVars(body.text, activeCreds)
          : body.bytes;
      default:
        return assertNever(body);
    }
  };

  /**
   * One outbound attempt. Re-runs header + body substitution against
   * the supplied creds so 401-retry sees the refreshed token. Returns
   * the upstream `Response` and the logical URL of the terminal hop.
   */
  const doUpstreamRequest = async (
    activeCreds: CredentialsResponse,
  ): Promise<{
    response: Response;
    finalUrl: string;
    hops: number;
    credentialsForwarded: boolean;
    /**
     * Names (never values) of the headers sent on the wire after
     * credential injection — surfaced for the debug diagnostic envelope
     * so an operator can see *which* headers were injected without ever
     * logging the secret itself.
     */
    requestHeaderNames: string[];
    /** Whether this attempt used the platform credential or an allowed caller override. */
    credentialInjection: "inject" | "caller_override" | "none";
  }> => {
    const resolvedHeaders: Record<string, string> = {};
    const credentialHeaders: string[] = [];
    for (const [key, value] of Object.entries(callerHeaders)) {
      resolvedHeaders[key] = substituteVars(value, activeCreds.credentials);
      if (resolvedHeaders[key] !== value) credentialHeaders.push(key);
    }
    // Server-side credential injection (Authorization, X-Api-Key, …).
    const credentialInjection = applyInjectedCredentialHeader(resolvedHeaders, activeCreds);
    const carrier = credentialCarryingHeader(credentialInjection);
    if (carrier) credentialHeaders.push(carrier);
    // ONE Cookie header (injected credential + caller cookies): the jar's base.
    const cookieKeys = Object.keys(resolvedHeaders).filter((k) => k.toLowerCase() === "cookie");
    const baseCookie = cookieKeys.map((k) => resolvedHeaders[k]).join("; ");
    for (const k of cookieKeys) delete resolvedHeaders[k];
    if (baseCookie) resolvedHeaders[cookieKeys[0]!] = baseCookie;

    // For the FormData body shape, drop a caller-supplied *multipart*
    // Content-Type (matched case-insensitively on the header NAME) so Bun's
    // fetch generates the `multipart/form-data; boundary=…` header itself —
    // a stale `boundary=old` token would desync from the bytes fetch
    // serialises and produce a wire-broken request upstream. The strip is
    // deliberately scoped to `multipart/*` VALUES only: a non-multipart
    // Content-Type (e.g. `application/json`) passes through untouched —
    // fetch's Request construction overrides it for the FormData body
    // anyway, and stripping it here would silently rewrite headers the
    // caller explicitly set (contract pinned by multipart.test.ts).
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
      proxy: args.proxyUrl || undefined,
    };
    // A streaming body's 30x comes back unfollowed (not replayable), and the model never sees
    // `location` (a redirect URL routinely carries credentials): a caller that must follow one
    // re-issues with a buffered body, which walks the chain under the per-hop policy.
    if (init.body instanceof ReadableStream) init.duplex = "half";
    const sent = await fetchApiCall({
      url: resolvedUrl,
      init,
      authorizedUris,
      declaredUris: deps.declaredUris,
      // The 4 policy, not the raw flag: a templated credential must not leave the allowlist.
      allowAllUris: policy.allowAllUris,
      credentialHeaders,
      cookies,
      integrationId,
      ...(fetchFn ? { fetchFn } : {}),
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
      logger,
      targetHost,
      credentialFields: redactionFields(policy, activeCreds.credentials),
    });
    return {
      ...sent,
      requestHeaderNames: Object.keys(resolvedHeaders),
      credentialInjection: credentialInjection.kind,
    };
  };

  // 7. First outbound request. Network/timeout errors surface as a
  //    structured failure rather than a raw exception.
  const requestStartedAt = performance.now();
  let upstream: Response;
  // No initializers: the try below assigns all four and the catch returns,
  // so any value here is unreadable.
  let upstreamFinalUrl: string;
  let upstreamHops: number;
  let requestHeaderNames: string[];
  let credentialInjection: "inject" | "caller_override" | "none";
  // The credentials the terminal response answered; null when no hop carried them to it.
  let answered: CredentialsResponse | null;
  try {
    const r = await doUpstreamRequest(creds);
    upstream = r.response;
    upstreamFinalUrl = r.finalUrl;
    upstreamHops = r.hops;
    requestHeaderNames = r.requestHeaderNames;
    credentialInjection = r.credentialInjection;
    answered = r.credentialInjection === "inject" && r.credentialsForwarded ? creds : null;
  } catch (err) {
    return wrapRequestError(err, integrationId, targetHost);
  }

  let authRefreshed = false;

  // 7b. Retry on 401 — force a refresh and re-issue the call. The platform
  //     `/refresh` flags the connection needsReconnection when the credential
  //     is terminally dead (revoked / unrefreshable / a non-oauth2 auth that
  //     401'd), so a `null` result means "do not retry". A non-null result is
  //     a genuine token rotation; replay once (buffered bodies only — streaming
  //     bodies are consumed once and cannot be replayed).
  if (
    upstream.status === 401 &&
    refreshCredentials &&
    config.platformApiUrl &&
    config.runToken &&
    answered &&
    !reportedAuthFailures.has(scope)
  ) {
    const fresh = await refreshCredentials(integrationId, answered).catch(() => null);
    if (fresh) {
      if (body.kind !== "streaming") {
        redactFields = redactionFields(policy, fresh.credentials);
        try {
          const r = await doUpstreamRequest(fresh);
          upstream = r.response;
          upstreamFinalUrl = r.finalUrl;
          upstreamHops = r.hops;
          requestHeaderNames = r.requestHeaderNames;
          credentialInjection = r.credentialInjection;
          answered = r.credentialInjection === "inject" && r.credentialsForwarded ? fresh : null;
        } catch (err) {
          return wrapRequestError(err, integrationId, targetHost);
        }
      } else {
        // Body already consumed — surface the rotated-but-still-401 signal to
        // the caller, which adds X-Auth-Refreshed.
        authRefreshed = true;
      }
    }
  }

  // 8. Terminal-hop Set-Cookie capture (buffered: idempotent re-merge; streaming: no follower).
  cookies.capture(upstreamFinalUrl, upstream.headers.getSetCookie());

  // 9. Log a persistent auth failure once per connection per run. The flag is
  //    set platform-side by the `/refresh` call above (which returns null on a
  //    terminal credential); here we only gate the one-refresh-attempt-per-run
  //    behaviour and surface a log line.
  if (upstream.status === 401 && answered && !reportedAuthFailures.has(scope)) {
    reportedAuthFailures.add(scope);
    logger.warn("Upstream returned 401 after refresh attempt", {
      integrationId,
      connectionId: args.connectionId,
    });
  }

  if (upstream.ok && answered) deps.reportUpstreamSuccess?.(answered);

  // 10. Success-path diagnostic envelope (#404). One structured line per
  //     completed call — resolved auth mode, hop count, status, duration,
  //     and the request/response header *names* (values redacted). Only
  //     emitted at LOG_LEVEL=debug, so it is silent in default production
  //     output yet available when an operator is debugging a provider call
  //     (401/403/redirect loop) without leaking the injected secret.
  logger.debug("integration api_call completed", {
    integrationId,
    method,
    host: redactCredentialHost(upstreamFinalUrl, redactFields),
    status: upstream.status,
    durationMs: Math.round(performance.now() - requestStartedAt),
    hops: upstreamHops,
    redirected: upstreamHops > 0,
    // How the credential was applied: a server-injected header (named, never
    // valued) or no injection at all (URL/query-embedded or anonymous).
    authMode: credentialInjection === "inject" ? "header" : credentialInjection,
    injectedHeader:
      credentialInjection === "inject" ? (creds.credentialHeaderName?.toLowerCase() ?? null) : null,
    // Which URL-trust policy gated the call.
    urlPolicy: policy.allowAllUris ? "allow_all" : "allowlist",
    authRefreshed,
    requestHeaderNames,
    // Drops Set-Cookie / WWW-Authenticate / Authorization etc.; keeps
    // operator-useful headers like Location for redirect-loop diagnosis.
    responseHeaders: filterSensitiveHeaders(upstream.headers),
  });

  return { ok: true, response: upstream, finalUrl: upstreamFinalUrl, authRefreshed };
}

/**
 * Outbound refusals and faults as structured failures: a refused target or hop is a policy
 * 403, an unresolvable target, an unusable credential or a network fault a 502, a silent
 * upstream a 504 — the platform proxy's statuses. Hosts only, as the target template names them:
 * a redirect target may encode capabilities.
 */
function wrapRequestError(err: unknown, integrationId: string, host: string): ApiCallFailure {
  const failure = classifyApiCallFailure(err);
  switch (failure.kind) {
    case "not_authorized":
    case "ssrf":
      return {
        ok: false,
        status: 403,
        error: failure.redirect
          ? failure.message
          : `Integration "${integrationId}": ${failure.message}`,
      };
    case "unresolvable":
      return {
        ok: false,
        status: 502,
        error: `Integration "${integrationId}": ${failure.message}`,
      };
    case "invalid_header":
      return {
        ok: false,
        status: 502,
        error: `Integration "${integrationId}": the connection's credential is unusable (${failure.message} once substituted or injected); nothing was sent`,
      };
    case "timeout":
      return { ok: false, status: 504, error: `Upstream timeout: ${host} did not answer in time` };
    case "transport":
      return {
        ok: false,
        status: 502,
        error: `Upstream request failed${failure.code ? `: ${failure.code}` : ""} (${host})`,
      };
  }
}
