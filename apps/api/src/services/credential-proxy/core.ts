// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy core — shared server-side logic for substituting
 * provider credentials into agent-generated requests and forwarding the
 * result upstream.
 *
 * Consumed by the `/api/credential-proxy/proxy` public endpoint, used
 * by external runners (CLI, GitHub Action, third-party agents) to
 * reach the application's providers from outside Appstrate. The caller
 * authenticates via an API key scoped with `credential-proxy:call`.
 *
 * The in-container sidecar uses its own `executeProviderCall` helper
 * (`runtime-pi/sidecar/credential-proxy.ts`) — same algorithm, same
 * shared primitives in `@appstrate/connect/proxy-primitives`, but
 * tailored to the per-run-token authorisation model.
 *
 * The module deliberately does NOT implement rate-limiting, authz, or
 * audit logging — those are the caller's responsibility. This function
 * assumes it has already been authorised to issue a call against
 * (applicationId, providerId) and focuses purely on the mechanics.
 */

import type { Db } from "@appstrate/db/client";
import {
  resolveCredentialsForProxy,
  forceRefreshCredentials,
  getProviderCredentialId,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthSchemeOnHeaders,
} from "@appstrate/connect";
import { isBlockedUrl } from "@appstrate/core/ssrf";

/**
 * Hard cap on the time we wait for the upstream provider. Mirrors the
 * sidecar's `OUTBOUND_TIMEOUT_MS` so CLI-driven calls and in-container
 * calls fail at the same boundary — no accidental hang on a slow
 * upstream.
 */
const OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * Minimal async cookie-jar shape consumed by {@link proxyCall}. The full
 * store implementation lives in `./cookie-jar.ts`; we only depend on the
 * narrow contract here so the core stays free of infra imports.
 */
export interface CookieJarAdapter {
  get(sessionId: string, providerKey: string): Promise<string[]>;
  set(sessionId: string, providerKey: string, cookies: string[], ttlSeconds: number): Promise<void>;
}

export interface ProxyCallInput {
  /** Application that owns the credentials. */
  applicationId: string;
  /** Organisation that owns the application (RBAC scope). */
  orgId: string;
  /**
   * Connection profile ID. For end-user impersonation this is the
   * end-user's `connectionProfileId`; for application-scoped keys it's
   * the application's default profile.
   */
  connectionProfileId: string;

  /** Scoped provider package name (e.g. `@afps/gmail`). */
  providerId: string;

  /** Upstream HTTP method. */
  method: string;
  /** Upstream URL — validated against the provider's `authorizedUris`. */
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
   * below to scope cookies per-provider within one session.
   */
  jarSessionId?: string;
  /** Per-provider scope key for the jar. Defaults to `providerId`. */
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

  /** Override fetch (tests). Defaults to the global fetch. */
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

export class ProxyAuthorizationError extends Error {
  readonly code = "UNAUTHORIZED_TARGET";
  constructor(message: string) {
    super(message);
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
 * Execute one authenticated proxy call. Credentials never leak into the
 * caller's response — the only thing that crosses the boundary is the
 * upstream response headers + body, streamed back as-is.
 */
export async function proxyCall(db: Db, input: ProxyCallInput): Promise<ProxyCallResult> {
  const fetchImpl = input.fetch ?? fetch;
  const sessionKey = input.sessionKey ?? input.providerId;

  const credentialId = await getProviderCredentialId(db, input.applicationId, input.providerId);
  if (!credentialId) {
    throw new ProxyCredentialError(
      `No provider credentials configured for '${input.providerId}' in application ${input.applicationId}`,
    );
  }
  const resolved = await resolveCredentialsForProxy(
    db,
    input.connectionProfileId,
    input.providerId,
    input.orgId,
    credentialId,
  );
  if (!resolved) {
    throw new ProxyCredentialError(`No credentials for provider '${input.providerId}'`);
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

  // authorizedUris gate (AFPS spec: `*` = one segment, `**` = any substring).
  // When `allowAllUris` is set we still block private/internal network
  // targets — mirror of the sidecar's SSRF safety net so the public
  // route can't be turned into an SSRF primitive by flipping a single
  // flag on a provider manifest.
  if (!resolved.allowAllUris) {
    const allowlist = resolved.authorizedUris ?? [];
    const ok = allowlist.some((p) => matchesAuthorizedUriSpec(p, target));
    if (!ok) {
      throw new ProxyAuthorizationError(
        `Target ${target} is not in the authorizedUris allowlist for ${input.providerId}`,
      );
    }
    if (allowlist.length === 0 && isBlockedUrl(target)) {
      throw new ProxyAuthorizationError(`Target ${target} resolves to a blocked network range`);
    }
  } else if (isBlockedUrl(target)) {
    throw new ProxyAuthorizationError(`Target ${target} resolves to a blocked network range`);
  }

  // Resolve caller headers, then let the shared injector add the pinned
  // credential header server-side (mirror of the sidecar — single source
  // of truth in `@appstrate/connect/proxy-primitives`).
  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const substituted = substituteVars(v, fields);
    const unresolved = findUnresolvedPlaceholders(substituted);
    if (unresolved.length > 0) {
      throw new ProxySubstitutionError(
        `Unresolved placeholders in header "${k}": {{${unresolved.join(",")}}}`,
      );
    }
    headers.set(k, substituted);
  }
  applyInjectedCredentialHeaderToHeaders(headers, resolved);
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
  let res = await fetchImpl(target, fetchInit as RequestInit);

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
      const refreshed = await forceRefreshCredentials(
        db,
        input.connectionProfileId,
        input.providerId,
        input.orgId,
        credentialId,
      );
      if (refreshed) {
        // Rebuild the credential header from the rotated token. We drop
        // the previous injected header first so `applyInjectedCredentialHeaderToHeaders`
        // re-installs the new value (its caller-override-wins semantics
        // would otherwise keep the stale Bearer).
        if (refreshed.credentialHeaderName) {
          headers.delete(refreshed.credentialHeaderName);
        }
        applyInjectedCredentialHeaderToHeaders(headers, refreshed);
        normalizeAuthSchemeOnHeaders(headers);
        res = await fetchImpl(target, {
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
      await forceRefreshCredentials(
        db,
        input.connectionProfileId,
        input.providerId,
        input.orgId,
        credentialId,
      );
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
    const { body: capped, truncated } = capResponseBody(res.body, cap);
    return { status: res.status, headers: res.headers, body: capped, truncated };
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
 * `truncated` is a flag object so the caller can read it after the stream
 * completes. It flips to `true` the moment the cap fires; it stays `false`
 * if the upstream ends naturally under the cap.
 */
function capResponseBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): { body: ReadableStream<Uint8Array>; truncated: boolean } {
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
  // after the stream has been consumed.
  return {
    body,
    get truncated() {
      return state.truncated;
    },
  } as { body: ReadableStream<Uint8Array>; truncated: boolean };
}

/** @internal Exported for unit testing */
export const _capResponseBodyForTesting = capResponseBody;
