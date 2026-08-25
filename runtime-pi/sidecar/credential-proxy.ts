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
  normalizeAuthSchemeTemplates,
  substituteVars,
  findUnresolvedPlaceholders,
  resolveAndCheckHost,
  OUTBOUND_TIMEOUT_MS,
  INTEGRATION_ID_RE,
  type CredentialsResponse,
  type HostResolver,
  type SidecarConfig,
} from "./helpers.ts";
import {
  fetchFollowingRedirectsCapturingCookies,
  hostLiterallyAllowlisted,
  mergeSetCookieIntoJar,
  redactHost,
  RedirectBlockedError,
} from "@appstrate/afps-runtime/resolvers";
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
interface ApiCallSuccess {
  ok: true;
  response: Response;
  /**
   * URL the response was eventually served from after any redirect
   * follow. Equals the resolved target URL when no redirect happened.
   *
   * Internal to this module: it drives the redirect follower and the
   * 401-retry replay. It is NOT projected onto the agent-visible
   * `_meta` — that projection existed for #471 but nothing ever read
   * it (`mcp-forward.ts` drops `_meta` wholesale), so it was removed
   * rather than left as a documented capability with no consumer.
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
 * the credential pair is layered on per integration at tool-build time.
 */
export interface ApiCallBaseDeps {
  config: SidecarConfig;
  /**
   * Run-wide sticky-cookie store. Bucketed by
   * {@link cookieBucketKey} — NOT by bare integration id; see that helper for
   * why the capture origin is part of the identity of a cookie.
   */
  cookieJar: Map<string, string[]>;
  fetchFn: typeof fetch;
  /**
   * Set tracking which integrations already had a persistent auth
   * failure logged in this run. Mutated by the function — shared
   * across calls so a flapping integration only logs once and so the
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
  fetchCredentials: (integrationId: string) => Promise<CredentialsResponse>;
  /**
   * Force a refresh on a mid-run 401. Resolves to the fresh credentials when
   * the token was actually rotated (the caller replays the request once), or
   * `null` when it was not — on a terminal failure the platform `/refresh`
   * already flagged the connection `needsReconnection`, so the caller must NOT
   * retry with a stale token.
   */
  refreshCredentials?: (integrationId: string) => Promise<CredentialsResponse | null>;
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

/** Collect unresolved `{{placeholders}}` left in a JSON value's string leaves. */
function findUnresolvedJsonPlaceholders(
  value: unknown,
  creds: Record<string, string>,
  acc: Set<string> = new Set(),
): Set<string> {
  if (typeof value === "string") {
    for (const p of findUnresolvedPlaceholders(substituteVars(value, creds))) acc.add(p);
  } else if (Array.isArray(value)) {
    for (const v of value) findUnresolvedJsonPlaceholders(v, creds, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) findUnresolvedJsonPlaceholders(v, creds, acc);
  }
  return acc;
}

/** Exhaustiveness guard: a new body kind without a buildBody case fails to compile here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled request-body kind: ${JSON.stringify(value)}`);
}

/**
 * Which URL policy admitted the call that captured (or is about to replay) a
 * cookie: `allowlist` when the integration's `authorized_uris` gated it,
 * `open` when nothing host-specific did (`allow_all_uris`, or no allowlist at
 * all — the SSRF floor is not a trust boundary, it only excludes internals).
 */
type CookieGate = "allowlist" | "open";

/**
 * Separator for {@link cookieBucketKey}. NUL cannot occur in a package id
 * (`INTEGRATION_ID_RE`) nor in a WHATWG origin, so the three parts of a key are
 * unambiguous and no integration id can be crafted to forge another's bucket.
 */
const COOKIE_KEY_SEP = "\u0000";

/**
 * Key of one bucket in the run-wide cookie jar.
 *
 * The jar used to be keyed on `integrationId` alone, with the cookie
 * attributes (Domain, Path, Secure, …) already stripped by
 * `mergeSetCookieIntoJar`. Nothing therefore recorded WHERE a cookie came
 * from, and every later `api_call` for that integration re-attached the whole
 * bucket. Under `allow_all_uris` the agent picks the host, so a live provider
 * session cookie shipped wherever the model named it. The
 * `substitutesCredential` exfiltration guard does not cover this: it only sees
 * `{{field}}` templating, and a replayed cookie is never templated.
 *
 * So the bucket identity is `(integration, gate, capture origin)`:
 *   - `origin` — WHATWG origin (scheme + host + port) of the call's INITIAL,
 *     policy-checked target. A whole redirect chain shares one bucket on
 *     purpose: #473 exists because the session cookie of an OAuth/CAS flow
 *     lands on an intermediate hop and must be usable by the next call to the
 *     origin that started the flow, and the redirect follower already strips
 *     cookies on an out-of-boundary cross-origin hop.
 *   - `gate` — see {@link CookieGate}. Recorded at capture time so
 *     {@link eligibleCookies} can tell an allowlist-gated bucket from one an
 *     `allow_all_uris` call created, without having to re-derive the policy
 *     for a URL it no longer has.
 */
export function cookieBucketKey(integrationId: string, gate: CookieGate, origin: string): string {
  return `${integrationId}${COOKIE_KEY_SEP}${gate}${COOKIE_KEY_SEP}${origin}`;
}

/** WHATWG origin of `url`, or `"null"` (the opaque origin) when unparseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/**
 * Cookies the run-wide jar may attach to a call for `targetOrigin`, deduped by
 * cookie name (the caller may overlay fresher entries on the returned map).
 *
 * Two admission rules, and only two:
 *   - Same origin as capture — always. That IS sticky-session continuity, and
 *     it is what the jar exists for.
 *   - Different origin — only when BOTH the capturing call and this call were
 *     gated by the integration's `authorized_uris`. That is the declared
 *     multi-host case (Dropbox `api ⇄ content`, Twilio `api ⇄ lookups ⇄
 *     verify`) and it takes the same stance as the redirect follower's hybrid
 *     credential strip 150 lines away in `api-call-engine.ts`: inside a
 *     declared allowlist, hosts are inside the trust boundary by construction;
 *     outside one, origin equality is the boundary (WHATWG). Cookies are
 *     credentials too.
 *
 * Same-origin buckets are folded in LAST so a fresh same-origin value wins
 * over a stale sibling-host one of the same name.
 */
function eligibleCookies(
  cookieJar: Map<string, string[]>,
  integrationId: string,
  gate: CookieGate,
  targetOrigin: string,
): Map<string, string> {
  const byName = new Map<string, string>();
  const fold = (cookies: readonly string[] | undefined) => {
    for (const ck of cookies ?? []) byName.set(ck.split("=")[0]!, ck);
  };
  if (gate === "allowlist") {
    const prefix = `${integrationId}${COOKIE_KEY_SEP}allowlist${COOKIE_KEY_SEP}`;
    for (const [key, cookies] of cookieJar) {
      if (key.startsWith(prefix)) fold(cookies);
    }
  }
  fold(cookieJar.get(cookieBucketKey(integrationId, "open", targetOrigin)));
  fold(cookieJar.get(cookieBucketKey(integrationId, "allowlist", targetOrigin)));
  return byName;
}

/**
 * True when `input` contains a `{{key}}` placeholder naming a decrypted
 * credential field. Mirrors the local resolver's `referencesCredentialField`:
 * an agent that templates a credential into an agent-controlled URL / header /
 * body must not be allowed to ship that secret to an arbitrary host under
 * `allow_all_uris`.
 */
// Reuses the canonical placeholder grammar so this exfil guard can never drift from what substituteVars actually substitutes.
const referencesCredentialField = (input: string, creds: Record<string, unknown>): boolean =>
  findUnresolvedPlaceholders(input).some((k) => k in creds);

/**
 * True when a `substituteBody: true` request body would have a decrypted
 * credential field templated into it. Exhaustive over every
 * {@link ApiCallRequestBody} kind — adding a new kind without deciding its
 * exfil-guard behaviour fails to compile via `assertNever`.
 */
function bodyReferencesCredential(
  body: ApiCallRequestBody,
  creds: Record<string, string>,
): boolean {
  switch (body.kind) {
    case "none":
    case "streaming":
      // Pass-through by design — no substitution ever happens on these kinds.
      return false;
    case "buffered":
      return body.text !== undefined && referencesCredentialField(body.text, creds);
    case "formData":
      return !!body.fieldTemplates?.some((t) => referencesCredentialField(t, creds));
    case "json":
      return referencesCredentialField(JSON.stringify(body.value), creds);
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
  //    targets when allowAllUris is set). The SSRF branches add the
  //    DNS-resolving rebind layer over the literal blocklist (see
  //    `refuseSsrfTarget`). On the allowlist branch, the SSRF gate
  //    applies UNLESS some entry pins this exact host literally —
  //    a named host resolving internally is the operator's declared
  //    topology (on-prem APIs are legitimate allowlist targets), but
  //    the AFPS glob grammar lets `**` span the host (`https://**`),
  //    and a glob-matched host is agent-chosen, not operator-chosen —
  //    without the gate that branch would be strictly weaker than
  //    allow_all.
  // 4a. Credential-exfiltration guard. When the agent templates a decrypted
  //     credential (`{{field}}`) into the agent-controlled URL, a header, or a
  //     substituted body, `allow_all_uris` MUST NOT be honoured — the SSRF net
  //     alone blocks only internal hosts, so the secret would still be
  //     shippable to any external attacker host. Downgrade to allowlist-only,
  //     mirroring the local resolver, and refuse outright if the integration
  //     declares no `authorized_uris` to constrain the destination.
  const substitutesCredential =
    referencesCredentialField(targetUrl, creds.credentials) ||
    Object.values(callerHeaders).some((v) => referencesCredentialField(v, creds.credentials)) ||
    (substituteBody && bodyReferencesCredential(body, creds.credentials));

  const effectiveAllowAll = creds.allowAllUris && !substitutesCredential;

  if (effectiveAllowAll) {
    const refusal = await refuseSsrfTarget(resolvedUrl, deps.resolveHost);
    if (refusal) return refusal;
  } else if (creds.authorizedUris && creds.authorizedUris.length) {
    if (!matchesAuthorizedUri(resolvedUrl, creds.authorizedUris)) {
      return {
        ok: false,
        status: 403,
        error: `URL not authorized for integration "${integrationId}". Allowed: ${creds.authorizedUris.join(", ")}`,
      };
    }
    if (!hostLiterallyAllowlisted(resolvedUrl, creds.authorizedUris)) {
      const refusal = await refuseSsrfTarget(resolvedUrl, deps.resolveHost);
      if (refusal) return refusal;
    }
  } else if (substitutesCredential) {
    // allow_all_uris was the only permission but the call would exfiltrate a
    // credential to an agent-chosen host — no allowlist exists to constrain it.
    return {
      ok: false,
      status: 403,
      error: `Call for integration "${integrationId}" substitutes a credential into an agent-controlled URL, header, or body but the integration declares no authorized_uris allowlist; refusing to prevent credential exfiltration.`,
    };
  } else {
    // No authorizedUris and no allowAllUris — apply the SSRF safety net.
    const refusal = await refuseSsrfTarget(resolvedUrl, deps.resolveHost);
    if (refusal) return refusal;
  }

  // 4b. Cookie scope for this call. `gate` records WHICH branch above
  //     admitted it, and `targetOrigin` where it is going — together they name
  //     the jar bucket this call may read from and will write to. See
  //     {@link cookieBucketKey}.
  const cookieGate: CookieGate =
    !effectiveAllowAll && creds.authorizedUris && creds.authorizedUris.length
      ? "allowlist"
      : "open";
  const targetOrigin = originOf(resolvedUrl);
  /**
   * Cookies captured by THIS call, across every redirect hop and the 401
   * retry. Kept separate from the run-wide jar so the redirect follower —
   * which knows nothing about origins and keys everything under the id it is
   * handed — cannot write into another origin's bucket. Promoted into the
   * run-wide jar once, at step 8, under this call's bucket.
   */
  const callJar = new Map<string, string[]>();

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
  if (substituteBody && body.kind === "json") {
    const unresolved = findUnresolvedJsonPlaceholders(body.value, creds.credentials);
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
   * both the upstream `Response` and the URL it was served from — the
   * streaming path reads it off `Response.url` (Bun populates this
   * after native redirect:"follow"), the manual-follow path threads
   * the terminal-hop URL through the loop.
   */
  const doUpstreamRequest = async (
    activeCreds: CredentialsResponse,
  ): Promise<{
    response: Response;
    finalUrl: string;
    hops: number;
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
    for (const [key, value] of Object.entries(callerHeaders)) {
      resolvedHeaders[key] = substituteVars(value, activeCreds.credentials);
    }
    // Server-side credential injection (Authorization, X-Api-Key, …).
    const credentialInjection = applyInjectedCredentialHeader(resolvedHeaders, activeCreds);
    // Re-inject sticky cookies — only those this call's origin is entitled to
    // (see `eligibleCookies`). Anything captured earlier in THIS call (a 401
    // retry replays after the first attempt's `Set-Cookie`) is fresher, so it
    // is overlaid last.
    const byName = eligibleCookies(cookieJar, integrationId, cookieGate, targetOrigin);
    for (const ck of callJar.get(integrationId) ?? []) byName.set(ck.split("=")[0]!, ck);
    if (byName.size) {
      const existing = resolvedHeaders["cookie"] || "";
      const stored = [...byName.values()].join("; ");
      resolvedHeaders["cookie"] = existing ? `${existing}; ${stored}` : stored;
    }

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
      // Streaming path issues a single unfollowed request — no manual hops.
      return {
        response,
        finalUrl: response.url || resolvedUrl,
        hops: 0,
        requestHeaderNames: Object.keys(resolvedHeaders),
        credentialInjection: credentialInjection.kind,
      };
    }
    const followed = await fetchFollowingRedirectsCapturingCookies({
      url: resolvedUrl,
      init,
      fetchFn,
      cookieJar: callJar,
      integrationId,
      injectedCredentialHeader:
        credentialInjection.kind === "inject"
          ? credentialInjection.header.name.toLowerCase()
          : credentialInjection.kind === "caller_override"
            ? credentialInjection.headerName.toLowerCase()
            : null,
      authorizedUris: creds.authorizedUris ?? undefined,
      allowAllUris: creds.allowAllUris,
      // Thread the injected DNS resolver into the per-hop SSRF rebind
      // check — same resolver the initial-target gate uses. Without it
      // the follower falls back to the system resolver, which diverges
      // from the sidecar's configured resolution (and fails closed on
      // every hop in tests).
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
      // Preserve the sidecar's structured per-hop refusal logging.
      logger,
    });
    return {
      ...followed,
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
  try {
    const r = await doUpstreamRequest(creds);
    upstream = r.response;
    upstreamFinalUrl = r.finalUrl;
    upstreamHops = r.hops;
    requestHeaderNames = r.requestHeaderNames;
    credentialInjection = r.credentialInjection;
  } catch (err) {
    return wrapRequestError(err, resolvedUrl);
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
    credentialInjection === "inject" &&
    !reportedAuthFailures.has(integrationId)
  ) {
    const fresh = await refreshCredentials(integrationId).catch(() => null);
    if (fresh) {
      if (body.kind !== "streaming") {
        try {
          const r = await doUpstreamRequest(fresh);
          upstream = r.response;
          upstreamFinalUrl = r.finalUrl;
          upstreamHops = r.hops;
          requestHeaderNames = r.requestHeaderNames;
          credentialInjection = r.credentialInjection;
        } catch (err) {
          return wrapRequestError(err, resolvedUrl);
        }
      } else {
        // Body already consumed — surface the rotated-but-still-401 signal to
        // the caller, which adds X-Auth-Refreshed.
        authRefreshed = true;
      }
    }
  }

  // 8. Terminal-hop Set-Cookie capture. No-op for buffered (the
  //    follower already merged every hop into `callJar`); load-bearing for
  //    streaming (final hop only — bodies can't be replayed).
  mergeSetCookieIntoJar(upstream.headers.getSetCookie(), callJar, integrationId);
  //    Promote what this call captured into the run-wide jar, tagged with the
  //    origin + policy that earned it. A whole redirect chain lands in the
  //    bucket of the INITIAL, policy-checked target: that is what keeps #473
  //    working (the session cookie of an OAuth/CAS flow is set on an
  //    intermediate hop and must serve the next call to the origin that
  //    started the flow), and the follower already strips cookies on an
  //    out-of-boundary cross-origin hop.
  const capturedCookies = callJar.get(integrationId);
  if (capturedCookies?.length) {
    mergeSetCookieIntoJar(
      capturedCookies,
      cookieJar,
      cookieBucketKey(integrationId, cookieGate, targetOrigin),
    );
  }

  // 9. Log a persistent auth failure once per integration per run. The flag is
  //    set platform-side by the `/refresh` call above (which returns null on a
  //    terminal credential); here we only gate the one-refresh-attempt-per-run
  //    behaviour and surface a log line.
  if (
    upstream.status === 401 &&
    credentialInjection === "inject" &&
    !reportedAuthFailures.has(integrationId)
  ) {
    reportedAuthFailures.add(integrationId);
    logger.warn("Upstream returned 401 after refresh attempt", { integrationId });
  }

  // 10. Success-path diagnostic envelope (#404). One structured line per
  //     completed call — resolved auth mode, hop count, status, duration,
  //     and the request/response header *names* (values redacted). Only
  //     emitted at LOG_LEVEL=debug, so it is silent in default production
  //     output yet available when an operator is debugging a provider call
  //     (401/403/redirect loop) without leaking the injected secret.
  logger.debug("integration api_call completed", {
    integrationId,
    method,
    host: redactHost(upstreamFinalUrl),
    status: upstream.status,
    durationMs: Math.round(performance.now() - requestStartedAt),
    hops: upstreamHops,
    redirected: upstreamFinalUrl !== resolvedUrl,
    // How the credential was applied: a server-injected header (named, never
    // valued) or no injection at all (URL/query-embedded or anonymous).
    authMode: credentialInjection === "inject" ? "header" : credentialInjection,
    injectedHeader:
      credentialInjection === "inject" ? (creds.credentialHeaderName?.toLowerCase() ?? null) : null,
    // Which URL-trust policy gated the call.
    urlPolicy: creds.allowAllUris
      ? "allow_all"
      : creds.authorizedUris && creds.authorizedUris.length
        ? "allowlist"
        : "ssrf_guard",
    authRefreshed,
    requestHeaderNames,
    // Drops Set-Cookie / WWW-Authenticate / Authorization etc.; keeps
    // operator-useful headers like Location for redirect-loop diagnosis.
    responseHeaders: filterSensitiveHeaders(upstream.headers),
  });

  return { ok: true, response: upstream, finalUrl: upstreamFinalUrl, authRefreshed };
}

/**
 * SSRF gate for every branch without a literal operator host pin
 * (allow_all, no allowlist, glob-matched allowlist): the literal
 * blocklist first (IP literals, known-internal names), then resolve every A/AAAA
 * record and refuse if ANY lands in a blocked range. A DNS name whose
 * record points inside (10.x, 169.254.169.254, …) passes `isBlockedUrl`
 * alone — this closes the rebind-to-internal vector.
 *
 * The outbound connection is delegated to `fetch`, which re-resolves —
 * so this is fail-closed defence-in-depth with a documented residual
 * TOCTOU, not a full resolve-and-pin (same posture as the MITM upstream
 * fetch and the platform CIMD guard; only the raw-socket egress
 * listeners can pin). Resolution failure maps to 502 — the same outcome
 * the subsequent fetch would have produced for an unresolvable host —
 * while a blocked answer is the policy 403.
 *
 * Returns the structured failure, or `null` when the target is clear.
 */
async function refuseSsrfTarget(
  url: string,
  resolveHost?: HostResolver,
): Promise<ApiCallFailure | null> {
  const blockedFailure: ApiCallFailure = {
    ok: false,
    status: 403,
    error: "URL targets a blocked network range",
  };
  if (isBlockedUrl(url)) return blockedFailure;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return blockedFailure;
  }
  const check = await resolveAndCheckHost(hostname, { resolve: resolveHost });
  if (!check.blocked) return null;
  if (check.reason === "resolution-failed") {
    return {
      ok: false,
      status: 502,
      error: `Target host could not be resolved (${redactHost(url)})`,
    };
  }
  logger.warn("api_call refused: target resolves into a blocked network range", {
    host: redactHost(url),
  });
  return blockedFailure;
}

function wrapFetchError(err: unknown, label: string, url: string): ApiCallFailure {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  const suffix = code ? `: ${code}` : "";
  // Same host projection every sibling in this file uses, from the one helper —
  // an inline `new URL(url).hostname` here was a second copy of `redactHost`.
  return { ok: false, status: 502, error: `${label}${suffix} (${redactHost(url)})` };
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
