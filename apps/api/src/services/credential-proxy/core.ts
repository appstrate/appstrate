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

import { substituteVars, applyInjectedCredentialHeaderToHeaders } from "@appstrate/connect";
import {
  buildInjectedCredentialHeader,
  credentialCarryingHeader,
} from "@appstrate/connect/proxy-primitives";
import {
  classifyApiCallFailure,
  cookieScope,
  credentialUrlPolicy,
  fetchApiCall,
  prepareApiCallRequest,
  redactionFields,
  templateHost,
  urlPolicyRefusalMessage,
  type CookieJar,
  type UrlPolicyRefusal,
} from "@appstrate/afps-runtime/resolvers";
import {
  assertHttpFieldValue,
  InvalidHeaderValueError,
} from "@appstrate/afps-shared/delivery-http";
import type { HostResolver } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { upstreamFailureDetail, type ProxyProblemCode } from "../../lib/proxy-status.ts";
import {
  resolveIntegrationProxyCredentials,
  forceRefreshIntegrationProxyCredentials,
  IntegrationCredentialNotFoundError,
  type ProxyRunSelection,
} from "./integration-resolver.ts";
import { clearUpstreamRejections } from "../integration-connections.ts";

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
  /** A stream body's byte length from the request's own framing; omitted = sent chunked. */
  bodyLength?: number;
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
  /** The target's host as its template names it: what a message about the upstream echoes. */
  redactedHost: string;
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
 * A call the proxy answered itself. The route reflects `message` to the caller and logs it, so
 * it MUST NEVER contain a substituted credential value — build it from redacted hosts only.
 * `connectionId` is set once the connection's credential may have left (a failure after dispatch).
 */
export class ProxyCallError extends Error {
  constructor(
    readonly code: ProxyProblemCode,
    message: string,
    readonly connectionId?: string,
  ) {
    super(message);
    this.name = "ProxyCallError";
  }
}

const REFUSAL_CODE: Record<UrlPolicyRefusal, ProxyProblemCode> = {
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
  let rejectionStreak: number;
  try {
    const result = await resolveIntegrationProxyCredentials(selection);
    resolved = result.payload;
    declaredUris = result.declaredUris;
    connectionId = result.connectionId;
    rejectionStreak = result.rejectionStreak;
    refreshSelection = { ...selection, connectionId };
  } catch (err) {
    if (err instanceof IntegrationCredentialNotFoundError) {
      throw new ProxyCallError("credential_not_found", err.message);
    }
    throw err;
  }

  const fields = resolved.credentials;
  const bodyTemplate = typeof input.body === "string" && input.substituteBody ? input.body : null;
  const prepared = prepareApiCallRequest({
    target: input.target,
    headers: input.headers ?? {},
    bodyTemplates: bodyTemplate !== null ? [bodyTemplate] : [],
    fields,
  });
  if (!prepared.ok) {
    const { kind, message } = prepared.refusal;
    throw new ProxyCallError(kind === "invalid_header" ? "invalid_request" : kind, message);
  }
  const { url: target, templates } = prepared.request;

  const authorizedUris = resolved.authorizedUris ?? [];
  const policy = credentialUrlPolicy({
    templates,
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
  const redactedHost = templateHost(input.target);

  // Every header carrying a decrypted credential (a caller `{{field}}`, or the one injected below
  // under any vendor name): a redirect leaving the allowlist strips them.
  const sensitiveHeaderNames = new Set<string>(prepared.request.credentialHeaders);
  const headers = new Headers();
  let credentialInjection;
  try {
    for (const [k, value] of Object.entries(prepared.request.headers)) {
      // The caller's own value was checked as written; one the credential spoils is unusable.
      assertHttpFieldValue(k, value);
      headers.set(k, value);
    }
    credentialInjection = applyInjectedCredentialHeaderToHeaders(headers, resolved);
  } catch (err) {
    throw err instanceof InvalidHeaderValueError
      ? unusableCredential(err.message, input.integrationId)
      : err;
  }
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
      body = substituteVars(bodyTemplate, fields);
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

  // False once the last exchange's redirect hops stripped the credential: its answer judges nothing.
  let credentialForwarded = true;
  const performFetch = async (fetchArgs: RequestInit): Promise<Response> => {
    try {
      const sent = await fetchApiCall({
        url: target,
        init: fetchArgs,
        bodyLength: input.bodyLength,
        authorizedUris,
        declaredUris,
        allowAllUris: policy.allowAllUris,
        credentialHeaders: [...sensitiveHeaderNames],
        // The platform's network is not the manifest author's to declare: a literal
        // `authorized_uris` host skips the SSRF gate only when `EGRESS_ALLOW_INTERNAL_HOSTS` lists it.
        internalHost: isAllowedInternalIdpHost,
        ...(cookies ? { cookies } : {}),
        integrationId: input.integrationId,
        ...(input.fetch ? { fetchFn: input.fetch } : {}),
        ...(input.resolveHost ? { resolveHost: input.resolveHost } : {}),
        targetHost: redactedHost,
        credentialFields: redactFields,
      });
      credentialForwarded = sent.credentialsForwarded;
      return sent.response;
    } catch (err) {
      throw toProxyCallError(err, input.integrationId, redactedHost, connectionId);
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

    // Reactive 401: a buffered body is replayable, so refresh and retry once. A streaming
    // body falls through to the `authRefreshed` signal below.
    if (
      res.status === 401 &&
      !isStreamBody &&
      credentialInjection.kind === "inject" &&
      credentialForwarded
    ) {
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
      } catch (err) {
        // A refreshed credential no header can carry is the connection's fault, not transient.
        if (err instanceof InvalidHeaderValueError) {
          throw unusableCredential(err.message, input.integrationId, connectionId);
        }
        // Refresh itself failed transiently (network hiccup, upstream 5xx, …)
        // — surface the original 401 as-is; the caller will
        // handle re-authentication. `forceRefresh` returns `null` rather than
        // throwing on every not-refreshed outcome: a revoked or missing refresh
        // token flags `needsReconnection`, an unrefreshable credential counts
        // the rejection toward the flag, and a transient failure leaves the
        // row untouched so the next call retries.
      }
    }
  } finally {
    await persistJar();
  }

  if (
    res.ok &&
    credentialInjection.kind === "inject" &&
    credentialForwarded &&
    rejectionStreak > 0
  ) {
    clearUpstreamRejections(connectionId, input.integrationId, selection).catch((err: unknown) =>
      logger.warn("credential-proxy: could not clear the connection's rejection streak", {
        connectionId,
        error: getErrorMessage(err),
      }),
    );
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
      // As above, the connection is flagged (or the rejection counted) by
      // this point, so the retry the caller re-issues is not the only thing
      // standing between the user and a reconnect prompt.
    }
    return {
      connectionId,
      redactedHost,
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
      redactedHost,
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
    redactedHost,
    status: res.status,
    headers: res.headers,
    body: res.body,
  };
}

/** A header the connection's credential makes invalid (`message` names the header, no value). */
function unusableCredential(
  message: string,
  integrationId: string,
  connectionId?: string,
): ProxyCallError {
  return new ProxyCallError(
    "credential_unusable",
    `Integration ${integrationId}: the connection's credential is unusable (${message} once substituted or injected); reconnect it with a valid value.`,
    connectionId,
  );
}

/** A relayed body whose read failed after its headers arrived, as the proxy's typed error. */
export function bodyReadError(err: unknown, redactedHost: string): ProxyCallError {
  const code =
    classifyApiCallFailure(err).kind === "timeout" ? "upstream_timeout" : "upstream_unreachable";
  return new ProxyCallError(code, upstreamFailureDetail(redactedHost, code));
}

/** `fetchApiCall`'s refusals and transport faults, as the proxy's typed errors. */
function toProxyCallError(
  err: unknown,
  integrationId: string,
  redactedHost: string,
  connectionId: string,
): Error {
  const failure = classifyApiCallFailure(err);
  // Only a refusal of the initial target sends nothing; a timeout or transport fault may follow it.
  const sent =
    failure.redirect || failure.kind === "timeout" || failure.kind === "transport"
      ? connectionId
      : undefined;
  switch (failure.kind) {
    case "not_authorized":
    case "ssrf":
      return new ProxyCallError(
        failure.kind === "ssrf" ? "blocked_target" : "unauthorized_target",
        `Integration ${integrationId}: ${failure.message}` +
          (failure.redirect ? "" : ` (host ${redactedHost})`),
        sent,
      );
    case "unresolvable":
      return new ProxyCallError("upstream_unresolvable", failure.message, sent);
    case "invalid_header":
      return unusableCredential(failure.message, integrationId);
    case "timeout":
      return new ProxyCallError(
        "upstream_timeout",
        upstreamFailureDetail(redactedHost, "upstream_timeout"),
        sent,
      );
    case "transport":
      return new ProxyCallError(
        "upstream_unreachable",
        upstreamFailureDetail(redactedHost, "upstream_unreachable"),
        sent,
      );
  }
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
