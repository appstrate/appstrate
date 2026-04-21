// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy core — shared server-side logic for substituting
 * provider credentials into agent-generated requests and forwarding the
 * result upstream.
 *
 * Used by:
 *   1. The `/api/credential-proxy/proxy` public endpoint (this repo).
 *      Caller authenticates via API key scoped with `credential-proxy:call`.
 *      Used by external runners (CLI, GitHub Action, third-party agents)
 *      to reach the application's providers from outside Appstrate.
 *   2. (In the longer-term plan) the runtime-pi sidecar `/proxy` handler.
 *      The contract is wire-compatible today; extracting the exact same
 *      code here is intentional so both entrypoints stay in lockstep.
 *
 * The module deliberately does NOT implement rate-limiting, authz, or
 * audit logging — those are the caller's responsibility. This function
 * assumes it has already been authorised to issue a call against
 * (applicationId, providerId) and focuses purely on the mechanics.
 */

import type { Db } from "@appstrate/db/client";
import { resolveCredentialsForProxy, getProviderCredentialId } from "@appstrate/connect";

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
  profileId: string;

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
   * substituted when `substituteBody` is true.
   */
  body?: string | Uint8Array | null;
  substituteBody?: boolean;

  /** Cookie jar (per-session). Mutated in place — caller owns the jar. */
  cookieJar?: Map<string, string[]>;
  /** Session key for cookie jar lookups; defaults to providerId. */
  sessionKey?: string;

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
 * Substitute {{field}} placeholders in `input` using `fields`. Unknown
 * placeholders are replaced with the empty string — matching the sidecar
 * convention; callers that want fail-closed behaviour should inspect the
 * result for remaining `{{…}}` markers before dispatching the request.
 */
function substitutePlaceholders(input: string, fields: Record<string, string>): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => fields[key] ?? "");
}

/**
 * Pattern match a URL against an `authorizedUris` entry. Supports `*`
 * (single path segment) and `**` (any substring) per the AFPS spec.
 */
function matchesAuthorizedUri(pattern: string, target: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§DOUBLESTAR§§/g, ".*") +
      "$",
  );
  return regex.test(target);
}

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
    input.profileId,
    input.providerId,
    input.orgId,
    credentialId,
  );
  if (!resolved) {
    throw new ProxyCredentialError(`No credentials for provider '${input.providerId}'`);
  }

  // authorizedUris gate
  if (!resolved.allowAllUris) {
    const allowlist = resolved.authorizedUris ?? [];
    const ok = allowlist.some((p) => matchesAuthorizedUri(p, input.target));
    if (!ok) {
      throw new ProxyAuthorizationError(
        `Target ${input.target} is not in the authorizedUris allowlist for ${input.providerId}`,
      );
    }
  }

  // Substitute placeholders in target + headers
  const fields = resolved.credentials;
  const target = substitutePlaceholders(input.target, fields);
  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers.set(k, substitutePlaceholders(v, fields));
  }

  // Body substitution (opt-in; body may be bytes). Bun's global fetch
  // accepts string / Uint8Array / ReadableStream directly.
  let body: string | Uint8Array | undefined;
  if (input.body !== undefined && input.body !== null) {
    if (typeof input.body === "string" && input.substituteBody) {
      body = substitutePlaceholders(input.body, fields);
    } else {
      body = input.body;
    }
  }

  // Cookie jar — inject stored cookies, capture any Set-Cookie.
  const jar = input.cookieJar;
  if (jar) {
    const cookies = jar.get(sessionKey);
    if (cookies && cookies.length > 0) {
      headers.set("Cookie", cookies.join("; "));
    }
  }

  const res = await fetchImpl(target, { method: input.method, headers, body });

  if (jar) {
    const setCookies = res.headers.getSetCookie?.();
    if (setCookies && setCookies.length > 0) {
      jar.set(sessionKey, setCookies);
    }
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
