// SPDX-License-Identifier: Apache-2.0

/**
 * /api/credential-proxy/proxy — public authenticated credential proxy.
 *
 * Used by external runners (CLI, GitHub Action, third-party agents) to
 * reach an application's providers without copying raw credentials out
 * of Appstrate. The CLI's `RemoteAppstrateProviderResolver` (spec.md
 * §8.3) is the canonical consumer; in-container runs reach the same
 * `executeProviderCall` helper via the sidecar's MCP `provider_call`
 * tool instead.
 *
 * Security: this is the single most sensitive endpoint in the public
 * API surface. Controls:
 *
 *   - Bearer auth only — API keys (headless / GitHub Action) and
 *     device-flow JWTs (`oauth2-instance`, `oauth2-dashboard`). Cookie
 *     sessions are rejected because the drive-by CSRF threat model
 *     doesn't fit an endpoint that reaches third-party providers.
 *   - Explicit `credential-proxy:call` scope — NOT granted by default
 *   - Per-application scope (principal cannot reach providers in another app)
 *   - Rate-limit: 100 req/min per principal (configurable via
 *     `CREDENTIAL_PROXY_LIMITS.rate_per_min`)
 *   - Session binding keyed on a namespaced principal id (`apikey:<id>`
 *     or `user:<id>`) — cookie jars can never be shared between a bearer
 *     JWT and an API key, nor between two API keys of the same org.
 *   - Audit log on every call (requestId, authMethod, apiKeyId, userId,
 *     endUserId, providerId, target, status)
 *   - URL allowlist enforced via the provider manifest
 *     (`authorizedUris` / `allowAllUris`)
 *   - Request / response size caps
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getErrorMessage } from "@appstrate/core/errors";

// Streaming cap — mirrored from runtime-pi/sidecar constants.
// The streaming/buffered decision is header-driven (X-Stream-Request),
// not threshold-driven, so only the hard cap is needed here.
const MAX_STREAMED_BODY_SIZE = 100 * 1024 * 1024; // 100 MB

/** Wall-clock timeout for piping an upstream streaming response to the client. */
export const STREAMING_PIPE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionProfiles, userApplicationProfiles } from "@appstrate/db/schema";
import { filterHeaders } from "@appstrate/connect/proxy-primitives";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import {
  invalidRequest,
  forbidden,
  notFound,
  internalError,
  payloadTooLarge,
} from "../lib/errors.ts";
import {
  proxyCall,
  ProxyAuthorizationError,
  ProxyCredentialError,
  ProxySubstitutionError,
} from "../services/credential-proxy/core.ts";
import { isValidSessionId, bindOrCheckSession } from "../services/credential-proxy/session.ts";
import { insertCredentialProxyUsage } from "../services/credential-proxy-usage.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Resolve the connection profile holding the credentials:
 *   - end-user in context: the end-user's default profile.
 *   - authenticated user (dashboard / CLI JWT) with no app-default:
 *     the user's own default profile. Mirrors how the platform dashboard
 *     resolves providers — the user's personal connection chain is used
 *     when no app-level profile has been provisioned.
 *   - else: the application's default profile (API-key callers).
 *
 * Applications on fresh installs often have no app-default profile —
 * they rely on `app-profile-bindings` to user profiles instead. Without
 * the user-profile fallback a `oauth2-instance`/`oauth2-dashboard`
 * caller would hit a 404 on every provider call despite having their
 * own connected account; that mismatch would make the CLI remote-run
 * flow unusable unless every admin hand-crafts an app-default profile.
 */
export async function resolveProfileId(args: {
  applicationId: string;
  endUserId?: string;
  userId?: string;
  /**
   * Optional explicit profile id from the `X-Connection-Profile-Id`
   * header. When set the resolver narrows to that profile after
   * validating the caller is allowed to use it (own user/end-user
   * profile, or an app profile in the request's application). Mismatched
   * ids surface as `null` so the route returns `404 — no credentials`,
   * keeping the failure mode aligned with the implicit-default path.
   */
  explicitProfileId?: string;
}): Promise<string | null> {
  if (args.explicitProfileId) {
    const [row] = await db
      .select({
        id: connectionProfiles.id,
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
        applicationId: connectionProfiles.applicationId,
      })
      .from(connectionProfiles)
      .where(eq(connectionProfiles.id, args.explicitProfileId))
      .limit(1);
    if (!row) return null;
    // Authorisation: the profile must belong to one of three buckets
    // the caller already owns. Anything else (another user's profile,
    // another app's profile) surfaces as null → 404.
    const ownsUser = row.userId !== null && row.userId === args.userId;
    const ownsEndUser = row.endUserId !== null && row.endUserId === args.endUserId;
    const ownsAppProfile = row.applicationId !== null && row.applicationId === args.applicationId;
    if (!ownsUser && !ownsEndUser && !ownsAppProfile) return null;
    return row.id;
  }
  if (args.endUserId) {
    const rows = await db
      .select({ id: connectionProfiles.id })
      .from(connectionProfiles)
      .where(
        and(
          eq(connectionProfiles.endUserId, args.endUserId),
          eq(connectionProfiles.isDefault, true),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }
  // Member's per-(user, app) sticky default — set via the dashboard
  // preferences page (or `appstrate connections profile switch` once the
  // CLI is server-aligned). Wins over the app's shared default but loses
  // to an explicit per-run override above.
  if (args.userId) {
    const stickyRows = await db
      .select({ id: userApplicationProfiles.profileId })
      .from(userApplicationProfiles)
      .where(
        and(
          eq(userApplicationProfiles.userId, args.userId),
          eq(userApplicationProfiles.applicationId, args.applicationId),
        ),
      )
      .limit(1);
    if (stickyRows[0]) return stickyRows[0].id;
  }
  const appRows = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.applicationId, args.applicationId),
        eq(connectionProfiles.isDefault, true),
        isNull(connectionProfiles.userId),
        isNull(connectionProfiles.endUserId),
      ),
    )
    .orderBy(sql`created_at asc`)
    .limit(1);
  if (appRows[0]) return appRows[0].id;

  if (args.userId) {
    const userRows = await db
      .select({ id: connectionProfiles.id })
      .from(connectionProfiles)
      .where(
        and(
          eq(connectionProfiles.userId, args.userId),
          eq(connectionProfiles.isDefault, true),
          isNull(connectionProfiles.applicationId),
          isNull(connectionProfiles.endUserId),
        ),
      )
      .limit(1);
    if (userRows[0]) return userRows[0].id;
  }
  return null;
}

/**
 * Auth methods the credential proxy accepts. The value is the
 * `c.get("authMethod")` string set by the auth pipeline — `"api_key"` for
 * headless `ask_` bearers, `"oauth2-instance"` for device-flow JWTs minted
 * by the interactive CLI (`/api/auth/cli/token`), `"oauth2-dashboard"`
 * for dashboard-session JWTs obtained via the OIDC authorization-code
 * flow. Cookie sessions (`"session"`) and any unknown strategy id are
 * rejected.
 */
const ACCEPTED_AUTH_METHODS: ReadonlySet<string> = new Set([
  "api_key",
  "oauth2-instance",
  "oauth2-dashboard",
]);

import { getCookieJarStore } from "../services/credential-proxy/cookie-jar.ts";
import { getCredentialProxyLimits } from "../services/proxy-limits.ts";

export function createCredentialProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = getCredentialProxyLimits();

  router.use("/*", requireAppContext());

  // Accept any HTTP method — the proxy preserves `req.method` on the
  // upstream fetch. A POST-only route would silently 404 GET/PUT/DELETE
  // tool calls, which the agent paraphrases as "the Gmail API is not
  // available".
  router.all(
    "/proxy",
    rateLimit(limits.rate_per_min),
    requirePermission("credential-proxy", "call"),
    async (c: Context<AppEnv>) => {
      // Accept headless API keys and bearer JWTs from the interactive CLI
      // (device-flow `oauth2-instance`) or dashboard (`oauth2-dashboard`).
      // Cookie sessions are refused — they would let a drive-by CSRF
      // trigger arbitrary provider calls on behalf of a logged-in user.
      const authMethod = c.get("authMethod");
      if (!ACCEPTED_AUTH_METHODS.has(authMethod)) {
        throw forbidden(
          `Credential proxy does not accept auth method "${authMethod}" (cookie sessions and unknown strategies rejected)`,
        );
      }

      const providerId = c.req.header("X-Provider");
      const target = c.req.header("X-Target");
      const sessionId = c.req.header("X-Session-Id");
      const substituteBody = c.req.header("X-Substitute-Body") === "true";
      // X-Run-Id is optional — populated by runners that want per-run
      // attribution in `credential_proxy_usage`. The value is not validated
      // against the principal here (matches llm-proxy behaviour); a
      // mismatched runId is a reporting oddity, not a security boundary.
      const runIdHeader = c.req.header("X-Run-Id");
      const runId = runIdHeader && runIdHeader.length > 0 ? runIdHeader : null;
      // X-Connection-Profile-Id is optional — when set the route narrows
      // to that profile (after ownership validation in resolveProfileId);
      // when absent the implicit default chain still applies.
      const explicitProfileHeader = c.req.header("X-Connection-Profile-Id");
      const explicitProfileId =
        explicitProfileHeader && explicitProfileHeader.length > 0 ? explicitProfileHeader : null;

      if (!providerId) throw invalidRequest("Missing X-Provider header");
      if (!target) throw invalidRequest("Missing X-Target header");
      if (!sessionId) throw invalidRequest("Missing X-Session-Id header");
      if (!isValidSessionId(sessionId)) {
        throw invalidRequest("X-Session-Id must be a UUID v4");
      }

      const applicationIdEarly = c.get("applicationId");
      const apiKeyIdEarly = c.get("apiKeyId");
      const userIdEarly = c.get("user").id;
      // Namespaced principal id — keeps JWT-user and API-key buckets
      // disjoint even when the underlying UUIDs happen to match.
      const principalId = apiKeyIdEarly ? `apikey:${apiKeyIdEarly}` : `user:${userIdEarly}`;
      const binding = await bindOrCheckSession(sessionId, principalId, limits.session_ttl_seconds);
      if (binding.kind === "mismatch") {
        logger.warn("credential-proxy: session reuse across principals", {
          sessionId,
          principalId,
          boundTo: binding.boundTo,
          authMethod,
          applicationId: applicationIdEarly,
        });
        throw forbidden("X-Session-Id is bound to a different principal");
      }

      // Optional request body cap
      const contentLength = c.req.header("Content-Length");
      if (contentLength && parseInt(contentLength, 10) > limits.max_request_bytes) {
        throw invalidRequest(
          `Request body exceeds CREDENTIAL_PROXY_LIMITS.max_request_bytes (${limits.max_request_bytes})`,
        );
      }

      const applicationId = c.get("applicationId");
      const orgId = c.get("orgId");
      const apiKeyId = c.get("apiKeyId");
      const userId = c.get("user").id;
      const endUser = c.get("endUser");

      // Resolve the profile that owns the credentials:
      //   - end-user profile when `Appstrate-User` was supplied
      //   - app-default profile, else
      //   - authenticated user's personal profile (dashboard / CLI JWT flows
      //     only — API keys operate on apps, not users).
      const userFallback =
        authMethod === "oauth2-dashboard" || authMethod === "oauth2-instance" ? userId : undefined;
      let profileId: string | null;
      try {
        profileId = await resolveProfileId({
          applicationId,
          endUserId: endUser?.id,
          ...(userFallback ? { userId: userFallback } : {}),
          ...(explicitProfileId ? { explicitProfileId } : {}),
        });
      } catch (err) {
        logger.error("credential-proxy: profile resolution failed", {
          applicationId,
          endUserId: endUser?.id,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
      if (!profileId) {
        throw notFound(
          endUser
            ? `End-user ${endUser.id} has no connection profile in application ${applicationId}`
            : `Application ${applicationId} has no default connection profile`,
        );
      }

      // Streaming control headers from the runtime.
      const streamRequest = c.req.header("x-stream-request") === "1";
      const streamResponse = c.req.header("x-stream-response") === "1";
      const declaredLen = parseInt(c.req.header("content-length") || "-1", 10);

      // Guard: declared Content-Length already exceeds the hard cap.
      if (streamRequest && declaredLen > MAX_STREAMED_BODY_SIZE) {
        throw payloadTooLarge("request body too large");
      }

      // Build a combined abort signal for streaming pipes: honours both the
      // request's client-disconnect signal and the wall-clock deadline.
      const pipeDeadline = AbortSignal.timeout(STREAMING_PIPE_TIMEOUT_MS);
      const pipeSignal = AbortSignal.any([c.req.raw.signal, pipeDeadline]);

      const streamLogCtx = {
        requestId: c.get("requestId"),
        orgId,
        providerId,
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

      // Forward upstream headers — strip (a) the proxy's control headers
      // (including the new x-stream-* transport hints — these must not
      // reach the upstream provider), (b) `host` and `content-length`
      // (caller's inbound Host would poison the upstream TLS SNI; fetch
      // recomputes Content-Length), and (c) RFC 7230 hop-by-hop headers.
      // Reuses the same `filterHeaders` helper as the in-container sidecar.
      const fwdHeaders = filterHeaders(c.req.header(), PROXY_CONTROL_HEADERS);

      // For streaming uploads, preserve the Content-Length header so the
      // upstream can frame the request body. Without this, some providers
      // reject the request with 411 Length Required.
      if (streamRequest && declaredLen > 0) {
        fwdHeaders["Content-Length"] = String(declaredLen);
      }

      const jar = await getCookieJarStore();

      const started = Date.now();
      try {
        // proxyCall now accepts ReadableStream bodies directly. When
        // streamRequest is true, the stream body is forwarded with
        // duplex: "half" and 401-retry is suppressed (body unreplayable);
        // authRefreshed is surfaced on the result instead.
        const result = await proxyCall(db, {
          applicationId,
          orgId,
          profileId,
          providerId,
          method,
          target,
          headers: fwdHeaders,
          body,
          substituteBody,
          cookieJar: jar,
          jarSessionId: sessionId,
          cookieJarTtlSeconds: limits.session_ttl_seconds,
          sessionKey: providerId,
          // When the client wants a streamed response, skip the platform
          // response-size cap — the capping transform stream in this
          // route enforces MAX_STREAMED_BODY_SIZE instead.
          maxResponseBytes: streamResponse ? 0 : limits.max_response_bytes,
        });

        const durationMs = Date.now() - started;

        logger.info("credential-proxy call", {
          requestId: c.get("requestId"),
          authMethod,
          apiKeyId,
          userId,
          endUserId: endUser?.id,
          applicationId,
          providerId,
          method,
          target,
          status: result.status,
          runId,
          durationMs,
        });

        // Record per-call metering for reporting. `request_id` is the row
        // UNIQUE key — replays (retries of the same proxy request) no-op.
        // Fire-and-forget: metering failure MUST NOT fail a successful
        // upstream call; the service logs and drops on DB error.
        void insertCredentialProxyUsage({
          orgId,
          apiKeyId: apiKeyId ?? null,
          userId: apiKeyId ? null : userId,
          runId,
          applicationId,
          providerId,
          targetHost: safeTargetHost(target),
          httpStatus: result.status,
          durationMs,
          costUsd: 0,
          requestId: c.get("requestId"),
        });

        const responseHeaders = new Headers();
        result.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower)) return;
          // Bun's upstream `fetch` auto-decodes `content-encoding`, so
          // `result.body` is already plain bytes. Forwarding the original
          // gzip header would make the caller's fetch double-decompress
          // and surface as an opaque connection error on the agent side.
          // `content-length` is dropped for the same reason — the body
          // length changed after decompression.
          if (lower === "content-encoding" || lower === "content-length") return;
          // Strip X-Stream-* headers: these are transport hints between the
          // runtime and this proxy; they must not be forwarded to the caller.
          if (lower === "x-stream-request" || lower === "x-stream-response") return;
          responseHeaders.set(key, value);
        });

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

        return new Response(result.body, {
          status: result.status,
          headers: responseHeaders,
        });
      } catch (err) {
        if (err instanceof ProxyAuthorizationError) {
          logger.warn("credential-proxy: target not in allowlist", {
            authMethod,
            apiKeyId,
            userId,
            applicationId,
            providerId,
            target,
          });
          throw forbidden(err.message);
        }
        if (err instanceof ProxyCredentialError) {
          throw notFound(err.message);
        }
        if (err instanceof ProxySubstitutionError) {
          throw invalidRequest(err.message);
        }
        logger.error("credential-proxy: unexpected failure", {
          authMethod,
          apiKeyId,
          userId,
          applicationId,
          providerId,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  return router;
}

const PROXY_CONTROL_HEADERS = new Set([
  "x-provider",
  "x-target",
  "x-session-id",
  "x-substitute-body",
  "x-run-id",
  "x-app-id",
  "x-connection-profile-id",
  // Streaming transport hints — consumed by this route, must not reach upstream.
  "x-stream-request",
  "x-stream-response",
  "x-max-response-size",
  "authorization",
  "appstrate-user",
  "appstrate-version",
  // Strip the caller's `accept-encoding` so Bun's upstream fetch picks
  // its own default and auto-decodes transparently — otherwise the
  // caller's list (e.g. `gzip, br, zstd`) can leak through to Gmail,
  // which returns an encoded body that the public route can't safely
  // forward (re-encoding would require rebuffering the whole stream).
  "accept-encoding",
]);

/**
 * Derive the audit-safe host for usage logging. Returns `null` for
 * unparseable targets — the usage record carries a nullable `target_host`
 * column so we never lose the attribution row on a malformed target.
 */
function safeTargetHost(target: string): string | null {
  try {
    return new URL(target).host;
  } catch {
    return null;
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Context passed to {@link capStreamingBody} for structured warning logs. */
interface StreamCapLogCtx {
  requestId: string;
  orgId: string;
  providerId: string;
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
          providerId: ctx.providerId,
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
        providerId: ctx.providerId,
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
