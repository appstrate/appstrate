// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy core — shared server-side logic for substituting
 * integration credentials into agent-generated requests and forwarding the
 * result upstream.
 *
 * Consumed by the `/api/credential-proxy/proxy` public endpoint, used
 * by external runners (CLI, GitHub Action, third-party agents) to
 * reach the space's integrations from outside Appstrate. The caller
 * authenticates via an API key scoped with `credential-proxy:call`.
 *
 * Credentials are resolved from `integration_connections` (the same
 * machinery behind the sidecar's `/internal/integration-credentials/*`
 * surface) via {@link resolveIntegrationProxyCredentials}.
 *
 * The sidecar and the CLI resolver source their credentials elsewhere; all three
 * send the call through `fetchApiCall` (`@appstrate/afps-runtime`).
 *
 * The module deliberately does NOT implement rate-limiting, authz, or
 * audit logging — those are the caller's responsibility. This function
 * assumes it has already been authorised to issue a call against
 * (spaceId, integrationId) and focuses purely on the mechanics.
 */

import {
  substituteVars,
  findUnresolvedPlaceholders,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthSchemeTemplate,
} from "@appstrate/connect";
import {
  buildInjectedCredentialHeader,
  credentialCarryingHeader,
} from "@appstrate/connect/proxy-primitives";
import {
  cookieScope,
  credentialUrlPolicy,
  fetchApiCall,
  PreflightError,
  redactCredentialHost,
  redactionFields,
  RedirectBlockedError,
  urlPolicyRefusalMessage,
  type CookieJar,
  type HostResolver,
  type UrlPolicyRefusal,
} from "@appstrate/afps-runtime/resolvers";
import { isAllowedInternalIdpHost } from "@appstrate/connect";
import type { Actor } from "../../lib/actor.ts";
import type { UpstreamFailureCode } from "../../lib/proxy-upstream-failure.ts";
import {
  resolveIntegrationProxyCredentials,
  forceRefreshIntegrationProxyCredentials,
  IntegrationCredentialNotFoundError,
  type ProxyRunSelection,
} from "./integration-resolver.ts";

/**
 * Minimal async cookie-jar shape consumed by {@link proxyCall}. The full
 * store implementation lives in `infra/cookie-jar/`; we only depend on the
 * narrow contract here so the core stays free of infra imports.
 */
interface CookieJarAdapter {
  get(sessionId: string, connectionId: string): Promise<CookieJar>;
  set(sessionId: string, connectionId: string, jar: CookieJar, ttlSeconds: number): Promise<void>;
}

interface ProxyCallInput {
  /** Org of the space — scopes the published integration version the call reads. */
  orgId: string;
  /** Space that owns the credentials. */
  spaceId: string;
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
  /** The run named by `X-Run-Id` — confines the call to the connections and version it froze. */
  run?: ProxyRunSelection;

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
   * upstream returns 401 after using the platform credential, the result
   * carries `authRefreshed: true` (creds were refreshed server-side) but the
   * response is passed through as-is — the caller must replay the next
   * request with a fresh body. An explicitly allowed caller override is never
   * attributed to the platform credential and therefore is not refreshed.
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
   * Jar lookup key (usually `sessionId`). Combined with the resolved connection id, so two
   * connections driven by one session never share cookies.
   */
  jarSessionId?: string;
  /** TTL applied on each write. Required when `cookieJar` is provided. */
  cookieJarTtlSeconds?: number;

  /**
   * Cap (bytes) on the upstream response body streamed back to the caller.
   * When the upstream sends more than this, the stream is truncated at the
   * boundary and `truncated: true` is set on the result. Undefined or 0
   * means no cap — the full response passes through.
   */
  maxResponseBytes?: number;

  /** Transport override (tests): keeps every per-hop guard, disables the address pin. */
  fetch?: typeof fetch;
  resolveHost?: HostResolver;
}

interface ProxyCallResult {
  /** The `integration_connections` row whose credential the call carried. */
  connectionId: string;
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

/** Stable problem `code` of each call the proxy refuses or cannot relay. */
export type ProxyErrorCode =
  | "unauthorized_target"
  | "blocked_target"
  | "credential_exfiltration_refused"
  | "credential_not_found"
  | "unresolved_placeholder"
  | UpstreamFailureCode;

/**
 * A call the proxy answered itself. The route reflects `message` to the caller and logs it, so
 * it MUST NEVER contain a substituted credential value — build it from redacted hosts only.
 */
export class ProxyCallError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProxyCallError";
  }
}

const REFUSAL_CODE: Record<UrlPolicyRefusal, ProxyErrorCode> = {
  unrendered: "unauthorized_target",
  unauthorized: "unauthorized_target",
  exfiltration: "credential_exfiltration_refused",
};

/**
 * Execute one authenticated proxy call. Credentials never leak into the
 * caller's response — the only thing that crosses the boundary is the
 * upstream response headers + body, streamed back as-is.
 */
export async function proxyCall(input: ProxyCallInput): Promise<ProxyCallResult> {
  const selection = {
    integrationId: input.integrationId,
    orgId: input.orgId,
    spaceId: input.spaceId,
    actor: input.actor,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.run ? { run: input.run } : {}),
  };
  let resolved;
  let declaredUris: readonly string[];
  // Both 401-refresh paths NAME the connection the call used: a new selection could pick another.
  let refreshSelection;
  let connectionId: string;
  try {
    const result = await resolveIntegrationProxyCredentials(selection);
    resolved = result.payload;
    declaredUris = result.declaredUris;
    connectionId = result.connectionId;
    refreshSelection = { ...selection, connectionId };
  } catch (err) {
    if (err instanceof IntegrationCredentialNotFoundError) {
      throw new ProxyCallError("credential_not_found", err.message);
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
    throw new ProxyCallError(
      "unresolved_placeholder",
      `Unresolved placeholders in target: {{${unresolvedInTarget.join(",")}}}`,
    );
  }
  // `Bearer{{token}}` is repaired on the TEMPLATE: a raw secret reaches the upstream as-is (#988).
  const headerTemplates = Object.entries(input.headers ?? {}).map(
    ([k, v]) => [k, normalizeAuthSchemeTemplate(k, v)] as const,
  );
  const bodyTemplate = typeof input.body === "string" && input.substituteBody ? input.body : null;

  const authorizedUris = resolved.authorizedUris ?? [];
  const policy = credentialUrlPolicy({
    templates: [
      input.target,
      ...headerTemplates.map(([, template]) => template),
      ...(bodyTemplate !== null ? [bodyTemplate] : []),
    ],
    fields,
    allowAllUris: resolved.allowAllUris,
    declaredUris,
    authorizedUris,
    injectsCredential: buildInjectedCredentialHeader(resolved) !== undefined,
  });
  if (policy.refuse) {
    throw new ProxyCallError(
      REFUSAL_CODE[policy.refuse],
      urlPolicyRefusalMessage(policy.refuse, input.integrationId),
    );
  }
  // `target` carries decrypted values and goes on the wire only; messages name `redactedHost`.
  const redactFields = redactionFields(policy, fields);
  const redactedHost = redactCredentialHost(target, redactFields);

  // Resolve caller headers, then let the shared injector add the pinned
  // credential header server-side (mirror of the sidecar — single source
  // of truth in `@appstrate/connect/proxy-primitives`).
  //
  // Every header carrying a decrypted credential (any vendor name, or a caller `{{field}}`),
  // collected at injection time: a redirect leaving the allowlist strips them.
  const sensitiveHeaderNames = new Set<string>();
  const headers = new Headers();
  for (const [k, template] of headerTemplates) {
    const substituted = substituteVars(template, fields);
    const unresolved = findUnresolvedPlaceholders(substituted);
    if (unresolved.length > 0) {
      throw new ProxyCallError(
        "unresolved_placeholder",
        `Unresolved placeholders in header "${k}": {{${unresolved.join(",")}}}`,
      );
    }
    if (substituted !== template) sensitiveHeaderNames.add(k);
    headers.set(k, substituted);
  }
  let credentialInjection = applyInjectedCredentialHeaderToHeaders(headers, resolved);
  const carrier = credentialCarryingHeader(credentialInjection);
  if (carrier) sensitiveHeaderNames.add(carrier);

  // Body substitution (opt-in; body may be bytes). Bun's global fetch
  // accepts string / Uint8Array / ReadableStream directly.
  // ReadableStream bodies bypass substitution — they are forwarded as-is.
  let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
  const isStreamBody = input.body instanceof ReadableStream;
  if (input.body !== undefined && input.body !== null) {
    if (isStreamBody) {
      body = input.body as ReadableStream<Uint8Array>;
    } else if (bodyTemplate !== null) {
      const substituted = substituteVars(bodyTemplate, fields);
      const unresolved = findUnresolvedPlaceholders(substituted);
      if (unresolved.length > 0) {
        throw new ProxyCallError(
          "unresolved_placeholder",
          `Unresolved placeholders in body: {{${unresolved.join(",")}}}`,
        );
      }
      body = substituted;
    } else {
      body = input.body as string | Uint8Array;
    }
  }

  const jarStore = input.cookieJar;
  const jarSessionId = input.jarSessionId;
  const jarTtl = input.cookieJarTtlSeconds;
  // Siblings share cookies only across hosts the manifest names literally, never a rendered one.
  const literalAllowlist = policy.allowAllUris ? null : declaredUris;
  // guardedFetch composes every hop's Cookie from this snapshot and captures every hop's
  // Set-Cookie into it; `captured` is replayed over a fresh read at the end.
  const captured: Array<[string, string[]]> = [];
  const scope =
    jarStore && jarSessionId
      ? cookieScope(
          await jarStore.get(jarSessionId, connectionId),
          input.integrationId,
          literalAllowlist,
        )
      : null;
  const cookies = scope && {
    header: (url: string, base: string | null) => scope.header(url, base),
    capture: (url: string, setCookies: string[]) => {
      scope.capture(url, setCookies);
      if (setCookies.length) captured.push([url, setCookies]);
    },
  };

  const fetchInit: RequestInit & { duplex?: string } = { method: input.method, headers, body };
  // fetch spec: streaming body requires `duplex: "half"`.
  if (isStreamBody) {
    fetchInit.duplex = "half";
  }

  const performFetch = async (fetchArgs: RequestInit): Promise<Response> => {
    try {
      const sent = await fetchApiCall({
        url: target,
        init: fetchArgs,
        authorizedUris,
        declaredUris,
        allowAllUris: policy.allowAllUris,
        credentialHeaders: [...sensitiveHeaderNames],
        // The platform's network is not the manifest author's to declare: only the operator's
        // `EGRESS_ALLOW_INTERNAL_HOSTS` skips the SSRF gate here.
        trustedHost: isAllowedInternalIdpHost,
        ...(cookies ? { cookies } : {}),
        integrationId: input.integrationId,
        ...(input.fetch ? { fetchFn: input.fetch } : {}),
        ...(input.resolveHost ? { resolveHost: input.resolveHost } : {}),
        credentialFields: redactFields,
      });
      return sent.response;
    } catch (err) {
      throw toProxyCallError(err, input.integrationId, redactedHost);
    }
  };

  // Re-read first: narrows (not closes) a concurrent lost update to one get/set round trip.
  const persistJar = async () => {
    if (!jarStore || !jarSessionId || !jarTtl || jarTtl <= 0 || captured.length === 0) return;
    const latest = await jarStore.get(jarSessionId, connectionId);
    const fresh = cookieScope(latest, input.integrationId, literalAllowlist);
    for (const [url, setCookies] of captured) fresh.capture(url, setCookies);
    await jarStore.set(jarSessionId, connectionId, latest, jarTtl);
  };

  // `finally`: hops received before a throw (off-allowlist redirect, SSRF, timeout) keep
  // their Set-Cookie, as in the sidecar.
  let res: Response;
  try {
    res = await performFetch(fetchInit as RequestInit);

    // Reactive 401-refresh-retry — mirror of the sidecar
    // (`executeApiCall`, runtime-pi/sidecar/credential-proxy.ts). The public route is
    // used by CLI / GitHub Action / self-hosted runners, which were silently
    // 401-ing whenever the stored OAuth access_token expired because the
    // refresh logic only fired on streaming bodies. Buffered bodies can be
    // replayed safely → refresh + retry once. Streaming bodies fall through
    // to the authRefreshed escape-hatch below (caller must re-issue with a
    // fresh body stream).
    if (res.status === 401 && !isStreamBody && credentialInjection.kind === "inject") {
      try {
        const refreshedResult = await forceRefreshIntegrationProxyCredentials(refreshSelection);
        const refreshed = refreshedResult?.payload ?? null;
        if (refreshed) {
          // Rebuild the credential header from the rotated token. Drop the
          // previous platform-injected value first so the refreshed delivery
          // plan can install its current header name and value cleanly.
          headers.delete(credentialInjection.header.name);
          if (refreshed.credentialHeaderName) {
            // Keep the strip set in sync — the refreshed payload may name a
            // different header than the original resolution.
            sensitiveHeaderNames.add(refreshed.credentialHeaderName);
          }
          credentialInjection = applyInjectedCredentialHeaderToHeaders(headers, refreshed);
          res = await performFetch({
            ...fetchInit,
            headers,
          } as RequestInit);
        }
      } catch {
        // Refresh itself failed transiently (network hiccup, upstream 5xx, …)
        // — surface the original 401 as-is; the caller will
        // handle re-authentication. `forceRefresh` flips `needsReconnection`
        // on BOTH terminal shapes before it gets here: a revoked refresh token
        // and an unrefreshable OAuth client. Both now return `null` rather
        // than throwing (the dedicated error class had one throw site whose
        // only catch was unreachable), so the flag is what separates TERMINAL
        // from transient — not the two terminal shapes from each other.
        // Transient failures deliberately leave the row untouched — nothing is
        // marked, and the next call retries.
      }
    }
  } finally {
    await persistJar();
  }

  // Streaming body on 401: credentials may be stale. Force-refresh them
  // server-side (so the *next* call from the caller uses fresh tokens)
  // but we cannot replay the body — surface authRefreshed so the route
  // can signal the client to retry itself with a fresh body stream.
  if (res.status === 401 && isStreamBody && credentialInjection.kind === "inject") {
    try {
      await forceRefreshIntegrationProxyCredentials(refreshSelection);
    } catch {
      // Refresh itself failed (invalid_grant, revoked token, etc.) —
      // surface the 401 as-is; the caller will handle re-authentication.
      // As above, both terminal shapes have already flagged
      // `needsReconnection` on the connection by this point, so the retry the
      // caller re-issues is not the only thing standing between the user and
      // a reconnect prompt.
    }
    return {
      connectionId,
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
      connectionId,
      status: res.status,
      headers: res.headers,
      body: capped.body,
      get truncated() {
        return capped.truncated;
      },
    };
  }

  return {
    connectionId,
    status: res.status,
    headers: res.headers,
    body: res.body,
  };
}

/** `fetchApiCall`'s refusals and transport faults, as the proxy's typed errors. */
function toProxyCallError(err: unknown, integrationId: string, redactedHost: string): unknown {
  if (err instanceof PreflightError) {
    if (err.reason === "unresolvable") {
      return new ProxyCallError("upstream_unresolvable", err.message);
    }
    return new ProxyCallError(
      err.reason === "ssrf" ? "blocked_target" : "unauthorized_target",
      `Integration ${integrationId}: ${err.message} (host ${redactedHost})`,
    );
  }
  if (err instanceof RedirectBlockedError) {
    return new ProxyCallError(
      err.reason === "ssrf" ? "blocked_target" : "unauthorized_target",
      `Integration ${integrationId}: ${err.message}`,
    );
  }
  if (err instanceof Error) {
    return err.name === "TimeoutError"
      ? new ProxyCallError("upstream_timeout", `${redactedHost} did not answer in time`)
      : new ProxyCallError("upstream_unreachable", `${redactedHost} could not be reached`);
  }
  return err;
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
