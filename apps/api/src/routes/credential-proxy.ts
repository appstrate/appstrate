// SPDX-License-Identifier: Apache-2.0

/**
 * /api/credential-proxy/proxy — public authenticated credential proxy.
 *
 * Used by external runners (CLI, GitHub Action, third-party agents) to
 * reach an application's providers without copying raw credentials out
 * of Appstrate. Wire-compatible with the sidecar `/proxy` contract — the
 * agent code-path (spec.md §8.3 `RemoteAppstrateProviderResolver`) is
 * identical to the in-container sidecar call.
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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionProfiles } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import { invalidRequest, forbidden, notFound, internalError } from "../lib/errors.ts";
import {
  proxyCall,
  ProxyAuthorizationError,
  ProxyCredentialError,
} from "../services/credential-proxy/core.ts";
import { isValidSessionId, bindOrCheckSession } from "../services/credential-proxy/session.ts";
import { insertCredentialProxyUsage } from "../services/credential-proxy-usage.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Resolve the connection profile holding the credentials for a given
 * (applicationId, optional endUser) pair:
 *   - with end-user: the end-user's default profile (exactly one by
 *     schema check constraint).
 *   - application-only: the application's default profile. Applications
 *     may have no default profile in fresh installs — in that case the
 *     caller surfaces a 404 rather than silently falling back.
 */
async function resolveProfileId(args: {
  applicationId: string;
  endUserId?: string;
}): Promise<string | null> {
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
  const rows = await db
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
  return rows[0]?.id ?? null;
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

/** Defaults aligned with the spec §10.3. Override via env var. */
interface CredentialProxyLimits {
  rate_per_min: number;
  max_request_bytes: number;
  max_response_bytes: number;
  session_ttl_seconds: number;
}

function parseLimits(): CredentialProxyLimits {
  const raw = process.env.CREDENTIAL_PROXY_LIMITS;
  const defaults: CredentialProxyLimits = {
    rate_per_min: 100,
    max_request_bytes: 10 * 1024 * 1024,
    max_response_bytes: 50 * 1024 * 1024,
    session_ttl_seconds: 3600,
  };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialProxyLimits>;
    return {
      rate_per_min: parsed.rate_per_min ?? defaults.rate_per_min,
      max_request_bytes: parsed.max_request_bytes ?? defaults.max_request_bytes,
      max_response_bytes: parsed.max_response_bytes ?? defaults.max_response_bytes,
      session_ttl_seconds: parsed.session_ttl_seconds ?? defaults.session_ttl_seconds,
    };
  } catch (err) {
    logger.warn("CREDENTIAL_PROXY_LIMITS is not valid JSON — using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
    return defaults;
  }
}

import { getCookieJarStore } from "../services/credential-proxy/cookie-jar.ts";

export function createCredentialProxyRouter() {
  const router = new Hono<AppEnv>();
  const limits = parseLimits();

  router.use("/*", requireAppContext());

  router.post(
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

      // Resolve the profile that owns the credentials: end-user profile
      // when an `Appstrate-User` header was supplied, the application's
      // default profile otherwise.
      let profileId: string | null;
      try {
        profileId = await resolveProfileId({ applicationId, endUserId: endUser?.id });
      } catch (err) {
        logger.error("credential-proxy: profile resolution failed", {
          applicationId,
          endUserId: endUser?.id,
          error: err instanceof Error ? err.message : String(err),
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

      // Body handling — read raw bytes when present so substitution can
      // operate on the decoded string.
      let body: string | Uint8Array | null = null;
      const method = c.req.method;
      if (method !== "GET" && method !== "HEAD") {
        const buf = await c.req.arrayBuffer();
        if (buf.byteLength > 0) {
          body = substituteBody ? new TextDecoder().decode(buf) : new Uint8Array(buf);
        }
      }

      // Forward upstream headers (stripped of the proxy's control ones
      // and hop-by-hop values).
      const fwdHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(c.req.header())) {
        const lower = name.toLowerCase();
        if (PROXY_CONTROL_HEADERS.has(lower)) continue;
        if (HOP_BY_HOP.has(lower)) continue;
        fwdHeaders[name] = value;
      }

      const jar = await getCookieJarStore();

      const started = Date.now();
      try {
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
          maxResponseBytes: limits.max_response_bytes,
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
          responseHeaders.set(key, value);
        });
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
        logger.error("credential-proxy: unexpected failure", {
          authMethod,
          apiKeyId,
          userId,
          applicationId,
          providerId,
          error: err instanceof Error ? err.message : String(err),
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
  "authorization",
  "appstrate-user",
  "appstrate-version",
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
