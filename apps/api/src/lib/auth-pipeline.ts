// SPDX-License-Identifier: Apache-2.0

/**
 * Shared auth pipeline.
 *
 * Production (`apps/api/src/index.ts`) and the test harness
 * (`apps/api/test/helpers/app.ts`) previously inlined an identical auth
 * chain — Better Auth handler mount + skipAuth / skipOrgContext helpers +
 * module strategies → Bearer API key → session cookie middleware +
 * permission resolution for sessions. This module is the single source of
 * truth for that pipeline so the two callers cannot drift.
 *
 * The only thing that legitimately differs between prod and tests is *how*
 * the `publicPaths` set and the `authStrategies` array are collected
 * (prod reads from the module loader singleton, tests read from an
 * injected `extraModules` list). Callers collect them and pass them in.
 */

import type { Hono } from "hono";
import type { AuthStrategy } from "@appstrate/core/module";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { getAuth } from "@appstrate/db/auth";
import { validateApiKey } from "../services/api-keys.ts";
import { ensureDefaultProfile } from "../services/connection-profiles.ts";
import { requireOrgContext } from "../middleware/org-context.ts";
import { requirePlatformRealm } from "../middleware/realm-guard.ts";
import { isEndUserInApp } from "../services/end-users.ts";
import { ApiError, unauthorized } from "./errors.ts";
import { resolvePermissions, resolveApiKeyPermissions } from "./permissions.ts";
import { getClientIp } from "./client-ip.ts";
import { logger } from "./logger.ts";
import type { AppEnv } from "../types/index.ts";

export interface AuthPipelineOptions {
  /**
   * Accessor for paths that bypass the auth middleware entirely.
   * Module-contributed public paths (e.g. Stripe webhook, OIDC login page)
   * are merged into this set by the caller. Wrapped in a function so the
   * value is read at request time — in production the pipeline is wired
   * before `await boot()` finishes loading modules, so a snapshot at
   * wire-time would miss module contributions.
   */
  publicPaths: () => Set<string>;
  /**
   * Accessor for module-contributed auth strategies, iterated in order.
   * The first strategy returning a non-null resolution claims the
   * request; if none match, the pipeline falls through to core Bearer
   * API key + session cookie auth. Also lazy for the same boot-order
   * reason as `publicPaths`.
   */
  authStrategies: () => readonly AuthStrategy[];
}

/**
 * Mount the Better Auth handler and install the full auth middleware chain
 * on the given Hono app. Behavior must stay byte-identical between the
 * production and test harness callers — any change here must preserve the
 * order: module strategies → Bearer API key → cookie session.
 */
export function applyAuthPipeline(app: Hono<AppEnv>, opts: AuthPipelineOptions): void {
  const { publicPaths, authStrategies } = opts;

  // Mount Better Auth handler — handles signup, signin, session, etc.
  //
  // Device-flow shim: RFC 8628 §3.2 + §3.4 specify
  // `application/x-www-form-urlencoded` as the required content type for
  // `/device/code` + `/device/token`, but Better Auth's `better-call`
  // router currently accepts only JSON. We rewrite form-urlencoded bodies
  // into JSON on the fly so the server is tolerant of BOTH content types
  // (RFC-compliant clients succeed, older JSON-sending binaries keep
  // working). Tracked in https://github.com/appstrate/appstrate/issues/166.
  app.on(["POST", "GET"], "/api/auth/*", async (c) => {
    const req = await maybeTransformDeviceFlowFormBody(c.req.raw);
    return getAuth().handler(req);
  });

  // Auth middleware: module strategies → Bearer API key → session cookie.
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, publicPaths())) return next();

    // Module-contributed auth strategies run first (first-match-wins).
    // Strategies MUST return `null` fast when the request does not match
    // their signature (e.g. a JWT strategy only claims `Bearer ey…`,
    // never `Bearer ask_…`). A strategy claiming every request would
    // shadow core API key auth — documented in `apps/api/src/modules/README.md`.
    const strategies = authStrategies();
    if (strategies.length > 0) {
      const strategyReq = {
        headers: c.req.raw.headers,
        method: c.req.method,
        path: c.req.path,
        request: c.req.raw,
      };
      for (const strategy of strategies) {
        const resolution = await strategy.authenticate(strategyReq);
        if (!resolution) continue;
        c.set("user", resolution.user);
        if (resolution.orgId !== undefined) c.set("orgId", resolution.orgId);
        if (resolution.orgSlug !== undefined) c.set("orgSlug", resolution.orgSlug);
        if (resolution.orgRole !== undefined) c.set("orgRole", resolution.orgRole);
        if (resolution.permissions.length > 0) {
          c.set("permissions", new Set(resolution.permissions));
        }
        c.set("authMethod", resolution.authMethod);
        if (resolution.applicationId !== undefined) {
          c.set("applicationId", resolution.applicationId);
        }
        if (resolution.endUser) {
          c.set("endUser", resolution.endUser);
        }
        if (resolution.deferOrgResolution) {
          c.set("deferOrgResolution", true);
        }
        return next();
      }
    }

    // Try Bearer API key
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ask_")) {
      const rawKey = authHeader.slice(7); // "Bearer ".length
      const keyInfo = await validateApiKey(rawKey);
      if (!keyInfo) {
        throw unauthorized("Invalid or expired API key");
      }
      c.set("user", { id: keyInfo.userId, email: keyInfo.email, name: keyInfo.name });
      c.set("orgId", keyInfo.orgId);
      c.set("orgSlug", keyInfo.orgSlug);
      c.set("orgRole", keyInfo.creatorRole);
      c.set("permissions", resolveApiKeyPermissions(keyInfo.scopes, keyInfo.creatorRole));
      c.set("authMethod", "api_key");
      c.set("apiKeyId", keyInfo.keyId);
      c.set("applicationId", keyInfo.applicationId);

      // Appstrate-User header: resolve end-user context (API key only)
      const targetEndUserId = c.req.header("Appstrate-User");
      if (targetEndUserId) {
        if (!targetEndUserId.startsWith("eu_")) {
          throw new ApiError({
            status: 400,
            code: "invalid_end_user_id",
            title: "Invalid End-User ID",
            detail: `Appstrate-User header must be an end-user ID with 'eu_' prefix, got '${targetEndUserId}'`,
            param: "Appstrate-User",
          });
        }
        const endUser = await isEndUserInApp(keyInfo.applicationId, targetEndUserId);
        if (!endUser) {
          throw new ApiError({
            status: 403,
            code: "invalid_end_user",
            title: "Invalid End-User",
            detail: `End-user '${targetEndUserId}' does not exist or does not belong to this application`,
            param: "Appstrate-User",
          });
        }
        logger.info("Appstrate-User end-user context", {
          requestId: c.get("requestId"),
          apiKeyId: keyInfo.keyId,
          authenticatedMember: keyInfo.userId,
          endUserId: endUser.id,
          applicationId: endUser.applicationId,
          method: c.req.method,
          path: c.req.path,
          ip: getClientIp(c),
          userAgent: c.req.header("user-agent") || "unknown",
        });
        c.set("endUser", endUser);
      }

      return next();
    }

    // Fallback: cookie session
    const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      throw unauthorized("Invalid or missing session");
    }

    // Appstrate-User header is NOT allowed with cookie auth
    if (c.req.header("Appstrate-User")) {
      throw new ApiError({
        status: 400,
        code: "header_not_allowed",
        title: "Header Not Allowed",
        detail: "Appstrate-User header is not allowed with cookie authentication",
        param: "Appstrate-User",
      });
    }

    c.set("user", {
      id: session.user.id,
      email: session.user.email ?? "",
      name: session.user.name ?? "",
    });
    c.set("authMethod", "session");
    // Look up the user's realm so the realm guard middleware below can
    // reject cookie sessions minted for a non-platform audience (OIDC
    // end-users) from hitting platform routes. We query the DB rather
    // than read `session.user.realm` because BA's `cookieCache` serializes
    // only the standard user fields into the cookie — custom columns
    // like `realm` are not reliably exposed on cached session objects
    // across BA versions. One indexed lookup on the user PK per
    // authenticated request is an acceptable cost for audience
    // enforcement; the platform route guards run after this so the
    // query cost is only paid on session-backed requests.
    const [userRow] = await db
      .select({ realm: userTable.realm })
      .from(userTable)
      .where(eq(userTable.id, session.user.id))
      .limit(1);
    if (userRow?.realm) c.set("sessionRealm", userRow.realm);

    // Ensure the user has a default connection profile (fire-and-forget)
    ensureDefaultProfile({ type: "member", id: session.user.id }).catch((err) => {
      logger.warn("Failed to ensure default profile", {
        userId: session.user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return next();
  });

  // Realm guard: reject BA cookie sessions belonging to a non-platform
  // audience (OIDC end-users) from hitting platform routes. Runs after
  // the auth middleware has resolved the session and set `sessionRealm`,
  // but before org-context + permission resolution (both of which are
  // meaningless for end-user sessions). OIDC/BA paths are exempt — see
  // `requirePlatformRealm` for the allowlist rationale.
  const realmGuard = requirePlatformRealm();
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, publicPaths())) return next();
    if (!c.get("user")) return next();
    return realmGuard(c, next);
  });

  // Org context middleware: require X-Org-Id for org-scoped /api/* routes.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (skipAuth(path, publicPaths())) return next();
    if (!c.get("user")) return next();
    // Non-session auth (API key, module strategies) already resolved orgId
    // and permissions inline. Session auth and strategies that set
    // `deferOrgResolution` defer org resolution to the X-Org-Id middleware.
    const method = c.get("authMethod");
    if (method !== "session" && !c.get("deferOrgResolution")) return next();
    if (skipOrgContext(path)) return next();
    return requireOrgContext()(c, next);
  });

  // Permission resolution for session auth (after org context sets orgRole).
  app.use("*", async (c, next) => {
    // Non-session auth methods set permissions inline — skip derivation.
    // Strategies with `deferOrgResolution` also defer permission resolution
    // until after org-context sets orgRole (same as session auth).
    const authMethod = c.get("authMethod");
    if (authMethod !== "session" && !c.get("deferOrgResolution")) return next();
    const orgRole = c.get("orgRole");
    if (orgRole) {
      c.set("permissions", resolvePermissions(orgRole));
    }
    return next();
  });
}

/**
 * Paths that skip both auth and org-context middleware. The `publicPaths`
 * set is passed in so callers can merge module-contributed paths with the
 * core allowlist.
 *
 * Exported so call sites that need to gate downstream middleware on the
 * same rule (e.g. app-context, api-version) can share this function.
 */
export function skipAuth(path: string, publicPaths: Set<string>): boolean {
  if (!path.startsWith("/api/")) return true;
  if (path.startsWith("/api/auth/")) return true; // Better Auth handles its own auth
  if (path.startsWith("/api/realtime/")) return true; // SSE endpoints use cookie auth internally
  if (path === "/api/connections/callback") return true; // OAuth redirect — no session
  if (path === "/api/uploads/_content") return true; // FS direct-upload sink — auth via HMAC token
  if (path === "/api/docs" || path === "/api/openapi.json") return true;
  // Unified-runner event ingestion: `/api/runs/:runId/events` and
  // `/api/runs/:runId/events/finalize` authenticate via Standard Webhooks
  // HMAC signature at the route layer — not via JWT / API key / cookie.
  if (REMOTE_RUN_EVENT_PATH_PATTERN.test(path)) return true;
  if (publicPaths.has(path)) return true; // module-contributed public paths
  return false;
}

const REMOTE_RUN_EVENT_PATH_PATTERN = /^\/api\/runs\/[^/]+\/events(\/finalize|\/heartbeat)?$/;

/**
 * Device-flow + CLI-token content-type shim.
 *
 * RFC 8628 specifies `application/x-www-form-urlencoded` at `/device/code`
 * and `/device/token`; the 2.x CLI (issue #165) extends that convention
 * to the new `/cli/token` and `/cli/revoke` endpoints it polls instead.
 * Better Auth's `better-call` router only accepts JSON, so if the incoming
 * request targets any of those paths with a form-urlencoded body we parse
 * the body, rewrite it as JSON, and return a fresh Request with
 * `Content-Type: application/json`. All other requests (including the
 * existing JSON clients used by the integration test suite) pass through
 * unchanged.
 *
 * Exported for unit testing — the transform has no side effects.
 */
const FORM_TO_JSON_PATHS = new Set([
  "/api/auth/device/code",
  "/api/auth/device/token",
  // Issue #165 — the 2.x CLI polls these endpoints with form-urlencoded
  // bodies for protocol parity with the RFC 8628 endpoints above. Without
  // this shim entry, every real CLI login hits `/api/auth/cli/token` with
  // a form body that better-call refuses — the integration tests pass
  // only because they POST JSON directly via `app.request`.
  "/api/auth/cli/token",
  "/api/auth/cli/revoke",
]);

export async function maybeTransformDeviceFlowFormBody(req: Request): Promise<Request> {
  if (req.method !== "POST") return req;
  const url = new URL(req.url);
  if (!FORM_TO_JSON_PATHS.has(url.pathname)) {
    return req;
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return req;
  }
  const raw = await req.text();
  const params = new URLSearchParams(raw);
  const body: Record<string, string> = {};
  for (const [key, value] of params.entries()) body[key] = value;
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  // Let fetch/BA recompute the length from the new body.
  headers.delete("content-length");
  return new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(body),
    // Preserve non-body fields. Request has no `duplex` reflection, but we
    // already consumed the original body so the replacement is a complete
    // new request — no streaming to preserve.
  });
}

/** Paths that need auth but not org-context (user-scoped or self-resolving). */
export function skipOrgContext(path: string): boolean {
  if (path === "/api/orgs" || path === "/api/orgs/") return true; // list/create orgs
  if (path.startsWith("/api/orgs/")) return true; // /api/orgs/:id/* handle their own auth
  if (path === "/api/profile" || path === "/api/profile/") return true;
  if (path === "/api/welcome/setup") return true;
  // `/api/me/orgs` is the prerequisite to picking an org and setting
  // `X-Org-Id` — it cannot itself depend on org context being already
  // resolved. Other `/api/me/*` routes (e.g. `/api/me/models`) DO require
  // org context and are intentionally not listed here.
  if (path === "/api/me/orgs" || path === "/api/me/orgs/") return true;
  return false;
}
