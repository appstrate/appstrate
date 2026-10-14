// SPDX-License-Identifier: Apache-2.0

/**
 * /api/credential-proxy/proxy — public authenticated credential proxy.
 *
 * Reaches a space's integrations without copying raw credentials out of
 * Appstrate, on one of two paths. A remote runner executing a run (the CLI's
 * `RemoteAppstrateIntegrationResolver`, a GitHub Action, a third-party agent)
 * names it with `X-Run-Id`; a script, a CLI command or a code agent calling
 * outside any run names none. In-container runs reach the same credential-proxy
 * core via the sidecar's MCP `{ns}__api_call` tools instead.
 *
 * `GET /api/credential-proxy/connections` lists what the caller reaches outside
 * a run.
 *
 * Security: this is the single most sensitive endpoint in the public
 * API surface. Controls:
 *
 *   - Bearer auth only — API keys (headless / GitHub Action) and
 *     device-flow JWTs (`oauth2-instance`, `oauth2-dashboard`). Cookie
 *     sessions are rejected because the drive-by CSRF threat model
 *     doesn't fit an endpoint that reaches third-party providers.
 *   - Permissions (`credential-proxy/access.ts`): `credential-proxy:call` with
 *     `X-Run-Id`, which must name the actor's own in-flight run that the caller
 *     executes (never one the platform executes); without it, `credential-proxy:call`
 *     reaches the connections usable in the space and `credential-proxy:call-own`
 *     the caller's own only
 *   - Per-space scope (principal cannot reach providers in another space)
 *   - Run binding — `X-Run-Id` confines the call to its run's bound connections,
 *     a colleague's shared one included (`selectAccessibleConnection`)
 *   - Rate-limit: 100 req/min per principal (configurable via
 *     `CREDENTIAL_PROXY_LIMITS.rate_per_min`)
 *   - Session binding keyed on a namespaced principal id (`apikey:<id>`
 *     or `user:<id>`) — cookie jars can never be shared between a bearer
 *     JWT and an API key, nor between two API keys of the same org.
 *   - Log line on every call; a journal row for every call that may have sent
 *     the connection's credential (`credential-proxy/call-journal.ts`), read by
 *     its owner and by the space's governor
 *   - RFC 9209 `Proxy-Status` on every response (`lib/proxy-status.ts`)
 *   - URL allowlist enforced via the integration manifest
 *     (`authorized_uris`; `allow_all_uris` unless a credential is templated)
 *   - Never sent upstream: the headers of the platform's own inbound request,
 *     by the one rule `isPlatformRequestHeader`
 *     (`@appstrate/connect/platform-request-headers`) — the caller's platform
 *     credential, its tenancy and persona, the platform's markers and
 *     versioning, the network path an edge adds on the way in, and the
 *     identity an auth proxy asserts — and this route's control headers
 *     (`credential-proxy/control-headers.ts`). Every other caller header is relayed
 *   - Upstream `Set-Cookie` never relayed to the caller
 *   - Request / response size caps
 */

import { Hono } from "hono";
import type { Context } from "hono";

// Streaming cap — single-sourced from the shared outbound-HTTP engine, the
// same module the in-container resolvers enforce it from, so this route and
// every runner apply one value. The streaming/buffered decision is
// header-driven (X-Stream-Request), not threshold-driven, so only the hard cap
// is needed here.
import { MAX_STREAMED_BODY_SIZE } from "@appstrate/afps-runtime/resolvers";

/** Wall-clock timeout for piping an upstream streaming response to the client. */
const STREAMING_PIPE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
import { isPlatformRequestHeader } from "@appstrate/connect/platform-request-headers";
import { stripUpstreamResponseHeaders } from "@appstrate/connect/proxy-primitives";
import { reportPermissionDenial } from "@appstrate/core/permissions";
import { getActor } from "../lib/actor.ts";
import { isUuid } from "../lib/db-helpers.ts";
import { listResponse } from "../lib/list-response.ts";
import { getSpaceScope } from "../lib/scope.ts";
import { logger } from "../lib/logger.ts";
import { callerPermissions } from "../lib/permissions.ts";
import { assertBearerOnly } from "../lib/bearer-only.ts";
import { relayIdempotencyKey } from "../middleware/idempotency.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireSpaceContext } from "../middleware/space-context.ts";
import {
  ApiError,
  invalidRequest,
  forbidden,
  internalError,
  payloadTooLarge,
} from "../lib/errors.ts";
import { proxyProblem, proxyStatusMarker, relayedProxyStatus } from "../lib/proxy-status.ts";
import { bodyReadError, proxyCall, ProxyCallError } from "../services/credential-proxy/core.ts";
import { recordConnectionCall } from "../services/credential-proxy/call-journal.ts";
import { trackAudit } from "../services/audit.ts";
import { PROXY_CONTROL_HEADERS } from "../services/credential-proxy/control-headers.ts";
import { isValidSessionId, bindOrCheckSession } from "../services/credential-proxy/session.ts";
import { authorizeProxyCall, reachOutsideRun } from "../services/credential-proxy/access.ts";
import {
  listConnectionsOutsideRun,
  runBoundSelection,
} from "../services/credential-proxy/integration-resolver.ts";
import type { AppEnv } from "../types/index.ts";

import { getCookieJarStore } from "../infra/index.ts";
import { getCredentialProxyLimits } from "../services/proxy-limits.ts";

export function createCredentialProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = getCredentialProxyLimits();

  router.use("/proxy", proxyStatusMarker());
  // `Idempotency-Key` is the upstream's here: the global guard lets it through to be relayed.
  router.use("/proxy", relayIdempotencyKey());
  router.use("/*", requireSpaceContext());

  // What the caller reaches outside a run: the rows and the rule `/proxy` selects from.
  router.get("/connections", requirePermission("credential-proxy", "call-own"), async (c) => {
    const reach = reachOutsideRun(callerPermissions(c));
    const data = await listConnectionsOutsideRun(getSpaceScope(c), getActor(c), reach);
    return c.json(listResponse(data));
  });

  // Accept any HTTP method — the proxy preserves `req.method` on the
  // upstream fetch. A POST-only route would silently 404 GET/PUT/DELETE
  // tool calls, which the agent paraphrases as "the Gmail API is not
  // available".
  router.all(
    "/proxy",
    rateLimit(limits.rate_per_min),
    // `credential-proxy:call` implies `call-own`; `authorizeProxyCall` requires `call` for a run.
    requirePermission("credential-proxy", "call-own"),
    async (c: Context<AppEnv>) => {
      // Accept headless API keys and bearer JWTs from the interactive CLI
      // (device-flow `oauth2-instance`) or dashboard (`oauth2-dashboard`).
      // Cookie sessions are refused — they would let a drive-by CSRF
      // trigger arbitrary upstream calls on behalf of a logged-in user.
      const authMethod = c.get("authMethod");
      assertBearerOnly(authMethod, "Credential proxy", {
        firstPartyLoopback: c.get("firstPartyLoopback"),
      });
      const orgId = c.get("orgId");
      const spaceId = c.get("spaceId");
      const apiKeyId = c.get("apiKeyId") || null;
      const userId = c.get("user").id;
      // Namespaced principal id — keeps JWT-user and API-key buckets
      // disjoint even when the underlying UUIDs happen to match.
      const principalId = apiKeyId ? `apikey:${apiKeyId}` : `user:${userId}`;
      const actor = getActor(c);
      // X-Run-Id is optional — a runner executing a run (`appstrate run --report`) sends it. With
      // or without it decides which permission the call needs and which connections it reaches.
      const runId = c.req.header("X-Run-Id") || null;
      if (runId !== null) {
        await authorizeProxyCall({
          permissions: callerPermissions(c),
          orgId,
          spaceId,
          actor,
          runId,
          onDenied: (required) => reportPermissionDenial(c, required),
        });
      }

      // Canonical header is `X-Integration-Id` (suffix parity with `X-Connection-Id`).
      const integrationId = c.req.header("X-Integration-Id");
      const target = c.req.header("X-Target");
      const sessionId = c.req.header("X-Session-Id");
      const substituteBody = readFlagHeader(c, "X-Substitute-Body");
      // X-Connection-Id is optional; the selector binds it to `X-Integration-Id`, so it can never
      // inject another integration's credentials under this integration's manifest.
      const explicitConnectionHeader = c.req.header("X-Connection-Id");
      const explicitConnectionId =
        explicitConnectionHeader && explicitConnectionHeader.length > 0
          ? explicitConnectionHeader
          : null;
      if (explicitConnectionId && !isUuid(explicitConnectionId)) {
        throw invalidRequest("X-Connection-Id must be a connection uuid", "X-Connection-Id");
      }

      if (!integrationId) throw invalidRequest("Missing X-Integration-Id header");
      if (!target) throw invalidRequest("Missing X-Target header");
      if (!sessionId) throw invalidRequest("Missing X-Session-Id header");
      if (!isValidSessionId(sessionId)) {
        throw invalidRequest("X-Session-Id must be a UUID v4");
      }

      const binding = await bindOrCheckSession(sessionId, principalId, limits.session_ttl_seconds);
      if (binding.kind === "mismatch") {
        logger.warn("credential-proxy: session reuse across principals", {
          sessionId,
          principalId,
          boundTo: binding.boundTo,
          authMethod,
          spaceId,
        });
        throw forbidden("X-Session-Id is bound to a different principal");
      }

      // The request's own framing: the body cap, and what a streamed upload is sent upstream with
      // (absent = chunked).
      const contentLength = c.req.header("content-length") ?? "";
      const declaredLen = /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
      if (declaredLen !== undefined && declaredLen > limits.max_request_bytes) {
        throw invalidRequest(
          `Request body exceeds CREDENTIAL_PROXY_LIMITS.max_request_bytes (${limits.max_request_bytes})`,
        );
      }

      const endUser = c.get("endUser");
      const run = runId ? runBoundSelection({ orgId, spaceId, runId, integrationId, actor }) : null;

      // Streaming control headers from the runtime.
      const streamRequest = readFlagHeader(c, "X-Stream-Request");
      const streamResponse = readFlagHeader(c, "X-Stream-Response");

      // Optional caller-supplied buffered-response cap. Clamped to the
      // platform `max_response_bytes` — a caller can only ask for a smaller
      // truncation cap, never a larger one. Ignored when streaming the
      // response (the streaming cap applies instead).
      const maxResponseSizeHeader = parseInt(c.req.header("x-max-response-size") || "", 10);
      const bufferedMaxResponseBytes =
        Number.isFinite(maxResponseSizeHeader) && maxResponseSizeHeader > 0
          ? Math.min(maxResponseSizeHeader, limits.max_response_bytes)
          : limits.max_response_bytes;

      // Guard: declared Content-Length already exceeds the hard cap.
      if (streamRequest && declaredLen !== undefined && declaredLen > MAX_STREAMED_BODY_SIZE) {
        throw payloadTooLarge("request body too large");
      }

      // Build a combined abort signal for streaming pipes: honours both the
      // request's client-disconnect signal and the wall-clock deadline.
      const pipeDeadline = AbortSignal.timeout(STREAMING_PIPE_TIMEOUT_MS);
      const pipeSignal = AbortSignal.any([c.req.raw.signal, pipeDeadline]);

      const streamLogCtx = {
        requestId: c.get("requestId"),
        orgId,
        integrationId,
        target,
      };

      // Body handling — read raw bytes when present so substitution can
      // operate on the decoded string. Streaming uploads skip the buffer
      // entirely — the raw body stream is forwarded directly to upstream
      // through a byte-counting cap (defense in depth when Content-Length
      // is absent or mis-declared).
      let body: string | Uint8Array | ReadableStream<Uint8Array> | null = null;
      const method = c.req.method;
      if (method !== "GET" && method !== "HEAD") {
        if (streamRequest && c.req.raw.body) {
          // Streaming upload path: forward body stream to upstream.
          // 401-retry is not possible (body unreplayable); the route
          // sets X-Auth-Refreshed: true on 401 so the client knows to
          // refresh credentials and replay the next call itself.
          // Apply byte-counting cap regardless of Content-Length — a
          // chunked upload without CL would otherwise bypass the guard above.
          body = capStreamingBody(
            c.req.raw.body as ReadableStream<Uint8Array>,
            MAX_STREAMED_BODY_SIZE,
            {
              ...streamLogCtx,
              direction: "upload",
            },
            pipeSignal,
          );
        } else {
          const buf = await c.req.arrayBuffer();
          if (buf.byteLength > 0) {
            body = substituteBody ? new TextDecoder().decode(buf) : new Uint8Array(buf);
          }
        }
      }

      // The caller's headers go upstream, except the platform's own request headers (its
      // credential, tenancy and markers) and this route's controls. `Accept-Encoding` stays here
      // too: Bun's upstream fetch negotiates its own and decodes, where the caller's list would
      // bring back an encoded body the route cannot relay without rebuffering it. `fetchApiCall`
      // drops Host, hop-by-hop and framing headers, a streamed upload's Content-Length coming
      // from `bodyLength`.
      const fwdHeaders = Object.fromEntries(
        Object.entries(c.req.header()).filter(([name]) => {
          const lower = name.toLowerCase();
          return (
            !isPlatformRequestHeader(lower) &&
            !PROXY_CONTROL_HEADERS.has(lower) &&
            lower !== "accept-encoding"
          );
        }),
      );

      const jar = await getCookieJarStore();
      const started = Date.now();
      // One row per call that may have sent the connection's credential, written once its outcome
      // is known: the upstream's status for a call relayed (a buffered body read to its end, a
      // streamed one handed over), else the proxy's own code for one that failed after dispatch.
      // Off the response path; `drainAudits` flushes it at shutdown.
      const journal = (connectionId: string, outcome: string) =>
        void trackAudit(
          recordConnectionCall({
            orgId,
            spaceId,
            connectionId,
            integrationId,
            actor,
            apiKeyId,
            authMethod,
            runId,
            method,
            target,
            outcome,
            durationMs: Date.now() - started,
            requestId: c.get("requestId"),
          }),
        );

      try {
        // proxyCall now accepts ReadableStream bodies directly. When
        // streamRequest is true, the stream body is forwarded with
        // duplex: "half" and 401-retry is suppressed (body unreplayable);
        // authRefreshed is surfaced on the result instead.
        const result = await proxyCall({
          orgId,
          spaceId,
          actor,
          ...(explicitConnectionId ? { connectionId: explicitConnectionId } : {}),
          ...(run ? { run } : { reach: reachOutsideRun(callerPermissions(c)) }),
          integrationId,
          method,
          target,
          headers: fwdHeaders,
          body,
          bodyLength: streamRequest ? declaredLen : undefined,
          substituteBody,
          cookieJar: jar,
          jarSessionId: sessionId,
          cookieJarTtlSeconds: limits.session_ttl_seconds,
          // When the client wants a streamed response, skip the platform
          // response-size cap — the capping transform stream in this
          // route enforces MAX_STREAMED_BODY_SIZE instead.
          maxResponseBytes: streamResponse ? 0 : bufferedMaxResponseBytes,
        });

        const durationMs = Date.now() - started;

        logger.info("credential-proxy call", {
          requestId: c.get("requestId"),
          authMethod,
          apiKeyId,
          userId,
          endUserId: endUser?.id,
          spaceId,
          integrationId,
          connectionId: result.connectionId,
          method,
          target,
          status: result.status,
          runId,
          durationMs,
        });

        // Buffer the (already size-capped) body before responding: the
        // `truncated` flag only flips once the capped stream is consumed, so
        // we must drain it here to know whether to emit `X-Truncated: true`.
        // The cap bounds this buffer to `limits.max_response_bytes`. A streamed
        // response is piped below instead, past this handler's return.
        let responseBody: ArrayBuffer | null = null;
        if (!streamResponse && result.body) {
          responseBody = await new Response(result.body).arrayBuffer().catch((err: unknown) => {
            // A read failing after the headers is the upstream's, never the proxy's own 500, and
            // what the caller is answered is what the journal keeps, not the status that came first.
            throw bodyReadError(err, result.redactedHost, result.connectionId);
          });
        }
        journal(result.connectionId, String(result.status));

        // Strip hop-by-hop + stale content-encoding/length (shared helper),
        // plus the route-specific set (transport hints, Set-Cookie).
        const responseHeaders = stripUpstreamResponseHeaders(
          result.headers,
          CALLER_RESPONSE_SKIP_HEADERS,
        );
        responseHeaders.append("Proxy-Status", relayedProxyStatus(result.status));
        // One URL serves every target and connection (they ride in headers), so an upstream
        // cache policy must not let a client replay one connection's response for another.
        responseHeaders.set("Cache-Control", "no-store");

        // Streaming upload on a 401: credentials may be stale but the body
        // cannot be replayed. Signal the client to refresh and retry itself.
        if (result.authRefreshed) {
          responseHeaders.set("X-Auth-Refreshed", "true");
        }

        // Streaming response path: pipe upstream bytes through a 100 MB
        // capping transform stream and wall-clock timeout. X-Truncated is
        // not applicable here — the stream throws instead, which closes the
        // connection and lets the client surface the error naturally.
        if (streamResponse && result.body) {
          const cappedStream = capStreamingBody(
            result.body,
            MAX_STREAMED_BODY_SIZE,
            {
              ...streamLogCtx,
              direction: "download",
            },
            pipeSignal,
          );
          // X-Truncated headers are not applicable to streaming responses.
          responseHeaders.delete("X-Truncated");
          responseHeaders.delete("X-Truncated-Size");
          return new Response(cappedStream, {
            status: result.status,
            headers: responseHeaders,
          });
        }

        if (result.truncated) responseHeaders.set("X-Truncated", "true");

        return new Response(responseBody, {
          status: result.status,
          headers: responseHeaders,
        });
      } catch (err) {
        // A dependency may already throw a well-formed RFC 9457 error (e.g.
        // assertIntegrationActive → notFound when the integration isn't
        // active). Surface it with its intended status instead of masking
        // every non-Proxy* error as a 500 below.
        if (err instanceof ApiError) throw err;
        if (err instanceof ProxyCallError) {
          // Named on a failure after dispatch: the call may have sent the credential.
          if (err.connectionId) journal(err.connectionId, err.code);
          const problem = proxyProblem(err.code, err.message);
          if (problem.status === 403) {
            logger.warn("credential-proxy: call refused", {
              code: err.code,
              authMethod,
              apiKeyId,
              userId,
              spaceId,
              integrationId,
              target,
            });
          }
          throw problem;
        }
        logger.error("credential-proxy: unexpected failure", {
          authMethod,
          apiKeyId,
          userId,
          spaceId,
          integrationId,
          // The name only: a runtime error (`Headers`, URL parsing) may quote a credential value.
          error: err instanceof Error ? err.name : typeof err,
        });
        throw internalError();
      }
    },
  );

  return router;
}

/** Boolean control headers: `1` / `0`, absent = `0`, anything else a 400. */
function readFlagHeader(c: Context<AppEnv>, name: string): boolean {
  const value = c.req.header(name);
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw invalidRequest(`${name} must be "1" or "0" (got "${value.slice(0, 32)}")`);
}

/** Not relayed to the caller: transport hints, and Set-Cookie (a cookie can be the credential). */
const CALLER_RESPONSE_SKIP_HEADERS = new Set([
  "x-stream-request",
  "x-stream-response",
  "set-cookie",
  "set-cookie2",
]);

/** Context passed to {@link capStreamingBody} for structured warning logs. */
interface StreamCapLogCtx {
  requestId: string;
  orgId: string;
  integrationId: string;
  target: string;
  direction: "upload" | "download";
}

/**
 * Wrap a streaming body in a WHATWG TransformStream that:
 *  - Counts bytes and errors the stream when `maxBytes` is exceeded
 *    (logs a `warn` with context before signalling the error).
 *  - Optionally aborts when `signal` fires (wall-clock timeout or
 *    client disconnect) — logs a `warn` and errors the stream.
 *
 * Used on both the upload path (streaming request to upstream) and the
 * download path (streaming response to the client) so the two directions
 * share identical cap + timeout semantics.
 *
 * Unlike the buffered cap used for inline responses, this does NOT
 * silently truncate — callers see a broken stream and can surface the
 * error naturally.
 */
function capStreamingBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  ctx: StreamCapLogCtx,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let received = 0;
  let capped = false;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (capped) return;
      received += chunk.byteLength;
      if (received > maxBytes) {
        capped = true;
        logger.warn("credential-proxy: streaming body exceeded size cap", {
          requestId: ctx.requestId,
          orgId: ctx.orgId,
          integrationId: ctx.integrationId,
          target: ctx.target,
          direction: ctx.direction,
          bytesReceived: received,
          maxBytes,
        });
        controller.error(
          new Error(
            `Streaming ${ctx.direction} exceeded ${maxBytes} bytes (MAX_STREAMED_BODY_SIZE)`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  // Abort handler: fires when either the client disconnects or the
  // wall-clock deadline elapses. Close the writable side so the
  // readable side errors and the client/upstream sees the abort.
  if (signal) {
    const onAbort = () => {
      if (capped) return;
      capped = true;
      const reason =
        signal.reason instanceof Error ? signal.reason : new Error("streaming timeout");
      logger.warn("credential-proxy: streaming pipe aborted", {
        requestId: ctx.requestId,
        orgId: ctx.orgId,
        integrationId: ctx.integrationId,
        target: ctx.target,
        direction: ctx.direction,
        bytesReceived: received,
        reason: reason.message,
      });
      // Abort the source and error the writable so the readable side closes.
      source.cancel(reason).catch(() => {});
      writable.abort(reason).catch(() => {});
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  source.pipeTo(writable).catch(() => {
    // pipeTo rejection is handled by the TransformStream error or the
    // abort handler above; swallow here to prevent an unhandled-rejection
    // in the Bun process.
  });
  return readable;
}
