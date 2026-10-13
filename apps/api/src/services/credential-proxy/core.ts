// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy core — shared server-side logic for substituting
 * integration credentials into agent-generated requests and forwarding the
 * result upstream.
 *
 * Consumed by the `/api/credential-proxy/proxy` public endpoint, used
 * from outside Appstrate to reach the space's integrations: by a remote
 * runner (CLI, GitHub Action, third-party agent) for the run it executes
 * (`X-Run-Id`), or outside any run on the caller's own connections. Which
 * of the two a caller may take is `access.ts`'s rule.
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

import { applyInjectedCredentialHeaderToHeaders } from "@appstrate/connect";
import {
  buildInjectedCredentialHeader,
  credentialCarryingHeader,
} from "@appstrate/connect/proxy-primitives";
import {
  classifyApiCallFailure,
  cookieScope,
  credentialUnusableMessage,
  credentialUrlPolicy,
  fetchApiCall,
  prepareApiCallRequest,
  type PreparedApiCallRequest,
  redactionFields,
  templateHost,
  URL_POLICY_REFUSAL_CODE,
  urlPolicyRefusalMessage,
  type CookieJar,
} from "@appstrate/afps-runtime/resolvers";
import { InvalidHeaderValueError } from "@appstrate/afps-shared/delivery-http";
import type { HostResolver } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import { EncryptionKeyUnavailableError } from "../../lib/stored-credential.ts";
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
   * header). When set, narrows to that specific connection: a member of the
   * run's bound set, or outside a run one of the actor's own.
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
   * Headers forwarded to upstream. Each `{{field}}` takes its credential field,
   * encoded for its place; the proxy adds the credential header (e.g.
   * `Authorization`) server-side.
   */
  headers?: Record<string, string>;
  /**
   * Optional request body. String bodies have `{{field}}` placeholders
   * substituted when `substituteBody` is true, each value encoded for the
   * body's `Content-Type`. A `ReadableStream` is
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

/** A key missing from the keyring is the proxy's own 503, never a relayed upstream 401. */
function rethrowKeyUnavailable(err: unknown, connectionId?: string): void {
  if (err instanceof EncryptionKeyUnavailableError) {
    throw new ProxyCallError("encryption_key_unavailable", err.message, connectionId);
  }
}

function logRefreshFault(err: unknown, integrationId: string, connectionId: string): void {
  logger.error("credential-proxy: recovering from a 401 failed — relaying the 401", {
    integrationId,
    connectionId,
    error: getErrorMessage(err),
  });
}

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
  let credentialRevision: string;
  let rejectionStreak: number;
  try {
    const result = await resolveIntegrationProxyCredentials(selection);
    resolved = result.payload;
    declaredUris = result.declaredUris;
    connectionId = result.connectionId;
    credentialRevision = result.credentialRevision;
    rejectionStreak = result.rejectionStreak;
    refreshSelection = { ...selection, connectionId };
  } catch (err) {
    if (err instanceof IntegrationCredentialNotFoundError) {
      throw new ProxyCallError("credential_not_found", err.message);
    }
    rethrowKeyUnavailable(err);
    throw err;
  }

  const fields = resolved.credentials;
  const prepareFor = (credentials: Record<string, string>) =>
    prepareApiCallRequest({
      target: input.target,
      headers: input.headers ?? {},
      body: typeof input.body === "string" && input.substituteBody ? input.body : null,
      fields: credentials,
    });
  const prepared = prepareFor(fields);
  if (!prepared.ok) {
    const { kind, message } = prepared.refusal;
    if (kind === "credential_unusable") throw unusableCredential(message, input.integrationId);
    throw new ProxyCallError(kind === "unresolved_placeholder" ? kind : "invalid_request", message);
  }
  const { url: target, templates } = prepared.request;

  const authorizedUris = resolved.authorizedUris ?? [];
  const policy = credentialUrlPolicy({
    target,
    templates,
    fields,
    allowAllUris: resolved.allowAllUris,
    declaredUris,
    authorizedUris,
    injectsCredential: buildInjectedCredentialHeader(resolved) !== undefined,
  });
  if (policy.refuse) {
    throw new ProxyCallError(
      URL_POLICY_REFUSAL_CODE[policy.refuse],
      urlPolicyRefusalMessage(policy.refuse, input.integrationId, templateHost(input.target)),
    );
  }
  // `target` carries decrypted values and goes on the wire only; messages name `redactedHost`.
  let redactFields = redactionFields(policy, fields);
  const redactedHost = templateHost(input.target);

  // Every header carrying a decrypted credential: a redirect leaving the allowlist strips them.
  const sensitiveHeaderNames = new Set<string>();
  const outbound = (request: PreparedApiCallRequest, payload: typeof resolved) => {
    const headers = new Headers(request.headers);
    const injection = applyInjectedCredentialHeaderToHeaders(headers, payload);
    const carrier = credentialCarryingHeader(injection);
    for (const name of request.credentialHeaders) sensitiveHeaderNames.add(name);
    if (carrier) sensitiveHeaderNames.add(carrier);
    return { headers, injection, body: request.body ?? input.body ?? undefined };
  };
  let first;
  try {
    first = outbound(prepared.request, resolved);
  } catch (err) {
    throw err instanceof InvalidHeaderValueError
      ? unusableCredential(err.message, input.integrationId)
      : err;
  }
  let credentialInjection = first.injection;
  const isStreamBody = input.body instanceof ReadableStream;

  const jarStore = input.cookieJar;
  const jarSessionId = input.jarSessionId;
  const jarTtl = input.cookieJarTtlSeconds;
  // Siblings share cookies only across hosts the manifest names literally, never a rendered one.
  const literalAllowlist = policy.allowAllUris ? null : declaredUris;
  // guardedFetch composes every hop's Cookie from this snapshot and captures every hop's
  // Set-Cookie into it; `captured` is replayed over a fresh read at the end, at its receipt time.
  const captured: Array<[string, string[], number]> = [];
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
      const now = Date.now();
      scope.capture(url, setCookies, now);
      if (setCookies.length) captured.push([url, setCookies, now]);
    },
  };

  const fetchInit: RequestInit & { duplex?: string } = {
    method: input.method,
    headers: first.headers,
    body: first.body,
  };
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
    for (const [url, setCookies, now] of captured) fresh.capture(url, setCookies, now);
    await jarStore.set(jarSessionId, connectionId, latest, jarTtl);
  };

  const logJarFault = (err: unknown) =>
    logger.error("credential-proxy: could not save the session's cookies", {
      integrationId: input.integrationId,
      connectionId,
      // The name only: the store's error may quote a cookie value.
      error: err instanceof Error ? err.name : typeof err,
    });

  // The jar is saved on both ways out: hops received before a throw (off-allowlist redirect,
  // SSRF, timeout) keep their Set-Cookie, as in the sidecar.
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
        const refreshed = await forceRefreshIntegrationProxyCredentials(
          refreshSelection,
          credentialRevision,
        );
        // A refreshed set that no longer fills the call is not replayed: the 401 stands.
        const again = refreshed ? prepareFor(refreshed.credentials) : null;
        if (again && !again.ok) {
          logger.warn("credential-proxy: refreshed credential does not fit the call, 401 relayed", {
            integrationId: input.integrationId,
            connectionId,
            reason: again.refusal.message,
          });
        }
        if (refreshed && again?.ok) {
          const next = outbound(again.request, refreshed);
          credentialInjection = next.injection;
          redactFields = redactionFields(policy, refreshed.credentials);
          res = await performFetch({
            ...fetchInit,
            headers: next.headers,
            body: next.body,
          } as RequestInit);
        }
      } catch (err) {
        // A refreshed credential no header can carry is the connection's fault, not transient.
        if (err instanceof InvalidHeaderValueError) {
          throw unusableCredential(err.message, input.integrationId, connectionId);
        }
        rethrowKeyUnavailable(err, connectionId);
        // Every verdict on the connection is a `null`, not a throw: what lands here is a fault
        // of the refresh or of the replay, and the caller still gets the original 401.
        logRefreshFault(err, input.integrationId, connectionId);
      }
    }
  } catch (err) {
    // The call's own error stays the one thrown; a store fault beside it is logged.
    await persistJar().catch(logJarFault);
    throw err;
  }
  try {
    await persistJar();
  } catch (err) {
    logJarFault(err);
    // The upstream answered, so the fault names the connection. No `cause`: see `logJarFault`.
    throw new ProxyCallError(
      "session_store_unavailable",
      `Integration ${input.integrationId}: the upstream was called, but the session's cookies could not be saved (host ${redactedHost})`,
      connectionId,
    );
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
      await forceRefreshIntegrationProxyCredentials(refreshSelection, credentialRevision);
    } catch (err) {
      rethrowKeyUnavailable(err, connectionId);
      logRefreshFault(err, input.integrationId, connectionId);
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

function unusableCredential(
  problem: string,
  integrationId: string,
  connectionId?: string,
): ProxyCallError {
  return new ProxyCallError(
    "credential_unusable",
    credentialUnusableMessage(integrationId, problem),
    connectionId,
  );
}

/** A relayed body whose read failed after its headers arrived, as the proxy's typed error. */
export function bodyReadError(
  err: unknown,
  redactedHost: string,
  connectionId: string,
): ProxyCallError {
  const { code } = classifyApiCallFailure(err);
  const upstream = code === "upstream_timeout" ? code : "upstream_unreachable";
  return new ProxyCallError(upstream, upstreamFailureDetail(redactedHost, upstream), connectionId);
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
    failure.redirect ||
    failure.code === "upstream_timeout" ||
    failure.code === "upstream_unreachable"
      ? connectionId
      : undefined;
  switch (failure.code) {
    case "unauthorized_target":
    case "blocked_target":
      return new ProxyCallError(
        failure.code,
        `Integration ${integrationId}: ${failure.message}` +
          (failure.redirect ? "" : ` (host ${redactedHost})`),
        sent,
      );
    case "upstream_unresolvable":
      return new ProxyCallError(failure.code, failure.message, sent);
    case "credential_unusable":
      return unusableCredential(failure.message, integrationId);
    case "upstream_timeout":
    case "upstream_unreachable":
      return new ProxyCallError(
        failure.code,
        upstreamFailureDetail(redactedHost, failure.code),
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

/** @internal Exported for unit testing */
export const _toProxyCallErrorForTesting = toProxyCallError;
