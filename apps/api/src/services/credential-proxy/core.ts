// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy core — shared server-side logic for substituting
 * integration credentials into agent-generated requests and forwarding the
 * result upstream.
 *
 * Consumed by the `/api/credential-proxy/proxy` public endpoint, used
 * by external runners (CLI, GitHub Action, third-party agents) to
 * reach the application's integrations from outside Appstrate. The caller
 * authenticates via an API key scoped with `credential-proxy:call`.
 *
 * Credentials are resolved from `integration_connections` (the same
 * machinery behind the sidecar's `/internal/integration-credentials/*`
 * surface) via {@link resolveIntegrationProxyCredentials}.
 *
 * The in-container sidecar uses its own `executeApiCall` helper
 * (`runtime-pi/sidecar/credential-proxy.ts`) — same algorithm, same
 * shared primitives in `@appstrate/connect/proxy-primitives`, but
 * tailored to the per-run-token authorisation model.
 *
 * The module deliberately does NOT implement rate-limiting, authz, or
 * audit logging — those are the caller's responsibility. This function
 * assumes it has already been authorised to issue a call against
 * (applicationId, integrationId) and focuses purely on the mechanics.
 */

import {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthSchemeOnHeaders,
} from "@appstrate/connect";
import { checkEgressUrl, egressGuardedFetch } from "../../lib/egress-host-guard.ts";
import { SsrfBlockedError } from "@appstrate/core/ssrf";
import type { Actor } from "../../lib/actor.ts";
import {
  resolveIntegrationProxyCredentials,
  forceRefreshIntegrationProxyCredentials,
  IntegrationCredentialNotFoundError,
  IntegrationCredentialRevokedError,
} from "./integration-resolver.ts";

/**
 * Hard cap on the time we wait for the upstream provider. Mirrors the
 * sidecar's `OUTBOUND_TIMEOUT_MS` so CLI-driven calls and in-container
 * calls fail at the same boundary — no accidental hang on a slow
 * upstream.
 */
const OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * Minimal async cookie-jar shape consumed by {@link proxyCall}. The full
 * store implementation lives in `infra/cookie-jar/`; we only depend on the
 * narrow contract here so the core stays free of infra imports.
 */
export interface CookieJarAdapter {
  get(sessionId: string, integrationKey: string): Promise<string[]>;
  set(
    sessionId: string,
    integrationKey: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void>;
}

export interface ProxyCallInput {
  /** Application that owns the credentials. */
  applicationId: string;
  /**
   * Actor whose `integration_connections` row is decrypted. End-user
   * impersonation (`Appstrate-User`) yields an `end_user` actor; dashboard
   * / CLI-JWT / API-key callers yield a `user` actor.
   */
  actor: Actor;
  /**
   * Optional `integration_connections` id pin (from the `X-Connection-Id`
   * header). When set, narrows to that specific connection (validated
   * against the actor's accessible set).
   */
  connectionId?: string;

  /** Scoped integration package name (e.g. `@afps/gmail`). */
  integrationId: string;

  /** Upstream HTTP method. */
  method: string;
  /** Upstream URL — validated against the integration's `authorizedUris`. */
  target: string;
  /**
   * Headers forwarded to upstream. Placeholder substitution (`{{field}}`)
   * runs against the credential fields; the proxy adds the credential
   * header (e.g. `Authorization`) server-side.
   */
  headers?: Record<string, string>;
  /**
   * Optional request body. String bodies have `{{field}}` placeholders
   * substituted when `substituteBody` is true. A `ReadableStream` is
   * forwarded verbatim (streaming upload path — no substitution possible,
   * no 401-retry). When a `ReadableStream` body is provided and the
   * upstream returns 401, the result carries `authRefreshed: true` (creds
   * were refreshed server-side) but the response is passed through as-is —
   * the caller must replay the next request with a fresh body.
   */
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  substituteBody?: boolean;

  /**
   * Cookie jar store — read before the upstream call, written after.
   * Pass `undefined` to disable cookie persistence for this call. The
   * store abstraction is async so Redis-backed implementations can be
   * used transparently.
   */
  cookieJar?: CookieJarAdapter;
  /**
   * Jar lookup key (usually `sessionId`). Combined with `sessionKey`
   * below to scope cookies per-integration within one session.
   */
  jarSessionId?: string;
  /** Per-integration scope key for the jar. Defaults to `integrationId`. */
  sessionKey?: string;
  /** TTL applied on each write. Required when `cookieJar` is provided. */
  cookieJarTtlSeconds?: number;

  /**
   * Cap (bytes) on the upstream response body streamed back to the caller.
   * When the upstream sends more than this, the stream is truncated at the
   * boundary and `truncated: true` is set on the result. Undefined or 0
   * means no cap — the full response passes through.
   */
  maxResponseBytes?: number;

  /**
   * Override the transport (tests). When omitted, the call goes through the
   * SSRF-guarded platform egress primitive ({@link egressGuardedFetch}) —
   * per-hop DNS re-validation, manual redirects, connection pinned to the
   * validated address. An injected fetch is still routed THROUGH that
   * primitive (keeping the per-hop guard and redirect discipline) but owns
   * the actual connection, so the address pin is disabled for it.
   */
  fetch?: typeof fetch;
}

export interface ProxyCallResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** True when the proxy had to truncate the response body. */
  truncated?: boolean;
  /**
   * True when the upstream returned 401 on a streaming-upload call and
   * credentials were refreshed server-side. The body cannot be replayed
   * so the caller must surface this flag to the client and let it retry
   * with a fresh body stream.
   */
  authRefreshed?: boolean;
}

/**
 * Authorization failure for a proxy call. The route reflects `message` to the
 * caller (403 body) and logs it, so it MUST NEVER contain a substituted
 * credential value — build messages from the REDACTED target representation
 * only (see {@link redactCredentialValues}), never from the substituted one.
 */
export class ProxyAuthorizationError extends Error {
  readonly code = "UNAUTHORIZED_TARGET";
  constructor(redactedMessage: string) {
    super(redactedMessage);
    this.name = "ProxyAuthorizationError";
  }
}

export class ProxyCredentialError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "ProxyCredentialError";
  }
}

/**
 * Thrown when a caller-supplied template references a credential field
 * that does not exist in the resolved payload. Mapped to 400 by the
 * route handler — a misconfigured agent, not an infrastructure error.
 */
export class ProxySubstitutionError extends Error {
  readonly code = "UNRESOLVED_PLACEHOLDER";
  constructor(message: string) {
    super(message);
    this.name = "ProxySubstitutionError";
  }
}

// `substituteVars` and `matchesAuthorizedUriSpec` are imported from
// `@appstrate/connect` to keep the credential-proxy server path and the
// in-container sidecar in lockstep. Any fix to placeholder substitution
// or URL allowlist matching MUST be made in
// `packages/connect/src/proxy-primitives.ts` so both entrypoints pick
// it up. Local helpers removed in Phase A.4.

/**
 * Restore `{{field}}` placeholders for every decrypted credential value that
 * appears in `value`. A caller-supplied template like
 * `https://{{access_token}}.evil.example` interpolates the DECRYPTED token
 * into the target before validation — any error message, log field or wrapped
 * transport error that echoes the substituted string would leak the secret to
 * the caller (the route reflects error messages in 403 bodies) and into logs.
 * This is the ONLY representation of a substituted string allowed to leave
 * this module other than on the wire to the validated upstream.
 *
 * Empty values are skipped (replacing `""` is meaningless), but there is
 * deliberately no minimum length: even a 1-char credential fragment must not
 * be echoed.
 */
function redactCredentialValues(value: string, fields: Record<string, string>): string {
  let out = value;
  for (const [name, fieldValue] of Object.entries(fields)) {
    if (typeof fieldValue !== "string" || fieldValue.length === 0) continue;
    out = out.split(fieldValue).join(`{{${name}}}`);
    // URL normalization (WHATWG parsing inside the egress guard / fetch)
    // percent-encodes reserved characters — scrub the encoded form too, or a
    // secret containing e.g. `/` or `+` would survive redaction inside a
    // normalized URL echoed by a transport error.
    const encoded = encodeURIComponent(fieldValue);
    if (encoded !== fieldValue) {
      out = out.split(encoded).join(`{{${name}}}`);
    }
  }
  return out;
}

/**
 * Execute one authenticated proxy call. Credentials never leak into the
 * caller's response — the only thing that crosses the boundary is the
 * upstream response headers + body, streamed back as-is.
 */
export async function proxyCall(input: ProxyCallInput): Promise<ProxyCallResult> {
  const sessionKey = input.sessionKey ?? input.integrationId;

  let resolved;
  try {
    const result = await resolveIntegrationProxyCredentials({
      integrationId: input.integrationId,
      applicationId: input.applicationId,
      actor: input.actor,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    });
    resolved = result.payload;
  } catch (err) {
    if (err instanceof IntegrationCredentialNotFoundError) {
      throw new ProxyCredentialError(err.message);
    }
    if (err instanceof IntegrationCredentialRevokedError) {
      throw new ProxyCredentialError(err.message);
    }
    throw err;
  }

  // Substitute placeholders in target (fail-closed on unresolved refs —
  // mirror of the sidecar; stops the proxy from leaking `{{foo}}` to the
  // upstream when a template references a non-existent field).
  const fields = resolved.credentials;
  const target = substituteVars(input.target, fields);
  const unresolvedInTarget = findUnresolvedPlaceholders(target);
  if (unresolvedInTarget.length > 0) {
    throw new ProxySubstitutionError(
      `Unresolved placeholders in target: {{${unresolvedInTarget.join(",")}}}`,
    );
  }
  // Redacted twin of `target`, computed ONCE. `target` carries decrypted
  // credential values (the substitution above) — it goes on the wire and
  // NOWHERE else. Every error message / log-bound string below must use
  // `redactedTarget` instead.
  const redactedTarget = redactCredentialValues(target, fields);

  // authorized_uris gate (AFPS spec: `*` = one segment, `**` = any substring).
  // When `allow_all_uris` is set we still block private/internal network
  // targets — mirror of the sidecar's SSRF safety net so the public
  // route can't be turned into an SSRF primitive by flipping a single
  // flag on an integration manifest. (Internal TS field names stay
  // camelCase per the documented Zone 3 carve-out — see
  // docs/CASING_CONVENTIONS.md — but user-facing error strings refer
  // to the AFPS wire vocabulary.)
  //
  // ONE matcher for the whole chain: the same assertion runs on the initial
  // target here AND — via `guardedFetch`'s `validateHop` — on EVERY redirect
  // hop, so a 302 cannot walk the request off the allowlist (cross-host OR a
  // same-host path escape like `/v1/me` → `/internal/dump`). The message is
  // built from the REDACTED form only: a hop URL can itself embed an
  // interpolated credential (vendor puts the token in a path, or echoes it
  // in a Location header).
  const assertHopAuthorized = (hopTarget: string): void => {
    if (resolved.allowAllUris) return;
    const allowlist = resolved.authorizedUris ?? [];
    const ok = allowlist.some((p) => matchesAuthorizedUriSpec(p, hopTarget));
    if (!ok) {
      throw new ProxyAuthorizationError(
        `Target ${redactCredentialValues(hopTarget, fields)} is not in the authorized_uris allowlist for ${input.integrationId}`,
      );
    }
    // Note: an empty allowlist can never reach here — `allowlist.some(...)` is
    // `false` for `[]`, so the `!ok` guard above already threw. (The former
    // `allowlist.length === 0 && isBlockedUrl(target)` branch was dead.)
  };
  assertHopAuthorized(target);

  // Canonical egress guard: parse + scheme floor + allowlist-aware literal +
  // DNS-rebind host gate, one decision shared with the other egress sites
  // (mirrors the sidecar credential-proxy). Runs for BOTH the authorized_uris
  // and allow_all_uris paths — a public hostname whose A/AAAA record points at a
  // private/loopback/link-local address is refused even when it matched an
  // authorized_uris pattern. Fail closed with the same authorization error.
  const egress = await checkEgressUrl(target);
  if (!egress.ok) {
    throw new ProxyAuthorizationError(
      `Target ${redactedTarget} resolves to a blocked network range`,
    );
  }

  // Resolve caller headers, then let the shared injector add the pinned
  // credential header server-side (mirror of the sidecar — single source
  // of truth in `@appstrate/connect/proxy-primitives`).
  //
  // Every header whose value carries a decrypted credential is recorded in
  // `sensitiveHeaderNames`, collected AT INJECTION TIME (not guessed from a
  // static list): the server-injected credential header can be any vendor
  // name (`X-Api-Key`, `X-Auth-Token`, …) and a caller template can put a
  // `{{field}}` in any header. The set is handed to the transport so a
  // cross-origin redirect strips these exactly like `Authorization`.
  const sensitiveHeaderNames = new Set<string>();
  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const substituted = substituteVars(v, fields);
    const unresolved = findUnresolvedPlaceholders(substituted);
    if (unresolved.length > 0) {
      throw new ProxySubstitutionError(
        `Unresolved placeholders in header "${k}": {{${unresolved.join(",")}}}`,
      );
    }
    if (substituted !== v) sensitiveHeaderNames.add(k);
    headers.set(k, substituted);
  }
  applyInjectedCredentialHeaderToHeaders(headers, resolved);
  if (resolved.credentialHeaderName) sensitiveHeaderNames.add(resolved.credentialHeaderName);
  normalizeAuthSchemeOnHeaders(headers);

  // Body substitution (opt-in; body may be bytes). Bun's global fetch
  // accepts string / Uint8Array / ReadableStream directly.
  // ReadableStream bodies bypass substitution — they are forwarded as-is.
  let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
  const isStreamBody = input.body instanceof ReadableStream;
  if (input.body !== undefined && input.body !== null) {
    if (isStreamBody) {
      body = input.body as ReadableStream<Uint8Array>;
    } else if (typeof input.body === "string" && input.substituteBody) {
      const substituted = substituteVars(input.body, fields);
      const unresolved = findUnresolvedPlaceholders(substituted);
      if (unresolved.length > 0) {
        throw new ProxySubstitutionError(
          `Unresolved placeholders in body: {{${unresolved.join(",")}}}`,
        );
      }
      body = substituted;
    } else {
      body = input.body as string | Uint8Array;
    }
  }

  // Cookie jar — inject stored cookies, capture any Set-Cookie.
  const jar = input.cookieJar;
  const jarSessionId = input.jarSessionId;
  const jarTtl = input.cookieJarTtlSeconds;
  if (jar && jarSessionId) {
    const cookies = await jar.get(jarSessionId, sessionKey);
    if (cookies.length > 0) {
      headers.set("Cookie", cookies.join("; "));
    }
  }

  const fetchInit: RequestInit & { duplex?: string } = {
    method: input.method,
    headers,
    body,
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  };
  // fetch spec: streaming body requires `duplex: "half"`.
  if (isStreamBody) {
    fetchInit.duplex = "half";
  }

  // Single outbound transport: the SSRF-guarded platform egress primitive.
  // Per-hop DNS re-validation + manual redirects + connection pinned to the
  // validated address. The previous raw `fetch` here followed redirects
  // blindly — an upstream 302 to an internal address bypassed the pre-flight
  // check entirely.
  //
  // `validateHop` re-runs the authorized_uris assertion on EVERY hop
  // (including hop 0), so a redirect that leaves the allowlist — cross-host
  // OR same-host off-path — ABORTS the exchange instead of being followed.
  // `sensitiveHeaders` extends the transport's cross-origin credential strip
  // to the vendor-specific header names collected at injection time above.
  //
  // Every error leaving this transport is scrubbed: `SsrfBlockedError`
  // embeds the blocked hop's hostname (derived from the SUBSTITUTED target
  // on the first hop) and Bun's fetch errors embed the full request URL —
  // both would leak interpolated credential values into the 403 body / logs.
  // `ProxyAuthorizationError` (thrown by `validateHop` on an off-allowlist
  // hop) is already redacted at construction and passes through unwrapped.
  const performFetch = async (fetchArgs: RequestInit): Promise<Response> => {
    try {
      return await egressGuardedFetch(target, fetchArgs, {
        ...(input.fetch ? { fetchImpl: input.fetch } : {}),
        validateHop: (url) => assertHopAuthorized(url.toString()),
        sensitiveHeaders: [...sensitiveHeaderNames],
      });
    } catch (err) {
      if (err instanceof ProxyAuthorizationError) {
        throw err; // validateHop abort — message already redacted
      }
      if (err instanceof SsrfBlockedError) {
        throw new ProxyAuthorizationError(
          `Target ${redactedTarget} was blocked by the egress guard (${err.reason})`,
        );
      }
      if (err instanceof Error) {
        const redacted = redactCredentialValues(err.message, fields);
        if (redacted !== err.message) {
          // The message embedded a credential value (Bun fetch errors carry
          // the request URL). Re-wrap with the scrubbed message; keep the
          // name so callers can still discriminate (e.g. TimeoutError). The
          // original error is deliberately NOT chained as `cause`.
          const clean = new Error(redacted);
          clean.name = err.name;
          throw clean;
        }
      }
      throw err;
    }
  };

  let res = await performFetch(fetchInit as RequestInit);

  // Reactive 401-refresh-retry — mirror of the sidecar
  // (runtime-pi/sidecar/credential-proxy.ts:259-285). The public route is
  // used by CLI / GitHub Action / self-hosted runners, which were silently
  // 401-ing whenever the stored OAuth access_token expired because the
  // refresh logic only fired on streaming bodies. Buffered bodies can be
  // replayed safely → refresh + retry once. Streaming bodies fall through
  // to the authRefreshed escape-hatch below (caller must re-issue with a
  // fresh body stream).
  if (res.status === 401 && !isStreamBody) {
    try {
      const refreshedResult = await forceRefreshIntegrationProxyCredentials({
        integrationId: input.integrationId,
        applicationId: input.applicationId,
        actor: input.actor,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      });
      const refreshed = refreshedResult?.payload ?? null;
      if (refreshed) {
        // Rebuild the credential header from the rotated token. We drop
        // the previous injected header first so `applyInjectedCredentialHeaderToHeaders`
        // re-installs the new value (its caller-override-wins semantics
        // would otherwise keep the stale Bearer).
        if (refreshed.credentialHeaderName) {
          headers.delete(refreshed.credentialHeaderName);
          // Keep the strip set in sync — the refreshed payload may name a
          // different header than the original resolution.
          sensitiveHeaderNames.add(refreshed.credentialHeaderName);
        }
        applyInjectedCredentialHeaderToHeaders(headers, refreshed);
        normalizeAuthSchemeOnHeaders(headers);
        res = await performFetch({
          ...fetchInit,
          headers,
        } as RequestInit);
      }
    } catch {
      // Refresh itself failed (invalid_grant, revoked token, network
      // hiccup, …) — surface the original 401 as-is; the caller will
      // handle re-authentication. `forceRefresh` already flips
      // `needsReconnection` on revocation.
    }
  }

  if (jar && jarSessionId && jarTtl && jarTtl > 0) {
    const setCookies = res.headers.getSetCookie?.();
    if (setCookies && setCookies.length > 0) {
      await jar.set(jarSessionId, sessionKey, setCookies, jarTtl);
    }
  }

  // Streaming body on 401: credentials may be stale. Force-refresh them
  // server-side (so the *next* call from the caller uses fresh tokens)
  // but we cannot replay the body — surface authRefreshed so the route
  // can signal the client to retry itself with a fresh body stream.
  if (res.status === 401 && isStreamBody) {
    try {
      await forceRefreshIntegrationProxyCredentials({
        integrationId: input.integrationId,
        applicationId: input.applicationId,
        actor: input.actor,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      });
    } catch {
      // Refresh itself failed (invalid_grant, revoked token, etc.) —
      // surface the 401 as-is; the caller will handle re-authentication.
    }
    return {
      status: res.status,
      headers: res.headers,
      body: res.body,
      authRefreshed: true,
    };
  }

  const cap = input.maxResponseBytes ?? 0;
  if (cap > 0 && res.body) {
    const capped = capResponseBody(res.body, cap);
    // `truncated` flips only once the stream is consumed by the caller, so
    // forward it as a live getter — snapshotting it here (the old
    // `const { truncated } = …`) always captured the initial `false`.
    return {
      status: res.status,
      headers: res.headers,
      body: capped.body,
      get truncated() {
        return capped.truncated;
      },
    };
  }

  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
  };
}

/**
 * Wrap a {@link ReadableStream} so it emits at most `maxBytes` bytes and
 * cancels the upstream source as soon as the cap is hit. The final chunk
 * is sliced at the exact boundary — downstream consumers never see more
 * than `maxBytes` cumulative bytes.
 *
 * `truncated` is exposed as a getter so the caller reads the up-to-date value
 * after the stream has been consumed. It flips to `true` the moment the cap
 * fires; it stays `false` if the upstream ends naturally under the cap.
 */
function capResponseBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): { body: ReadableStream<Uint8Array>; readonly truncated: boolean } {
  const state = { truncated: false };
  let sent = 0;
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (!value) return;
      const remaining = maxBytes - sent;
      if (value.byteLength <= remaining) {
        sent += value.byteLength;
        controller.enqueue(value);
        return;
      }
      if (remaining > 0) {
        controller.enqueue(value.slice(0, remaining));
        sent = maxBytes;
      }
      state.truncated = true;
      controller.close();
      await reader.cancel();
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  // Expose the flag via a getter so the caller reads the up-to-date value
  // after the stream has been consumed. The explicit return type (no cast)
  // keeps the getter typed without an `as` lie.
  return {
    body,
    get truncated() {
      return state.truncated;
    },
  };
}

/** @internal Exported for unit testing */
export const _capResponseBodyForTesting = capResponseBody;
