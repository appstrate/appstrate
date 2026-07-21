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
import { requireOrgContext } from "../middleware/org-context.ts";
import { requirePlatformRealm } from "../middleware/realm-guard.ts";
import { isEndUserInApp } from "../services/end-users.ts";
import { ApiError, unauthorized } from "./errors.ts";
import { clearStaleAuthCookies } from "./auth-cookies.ts";
import { authChallengeResponder } from "./auth-challenges.ts";
import { enforceResourceAudience } from "./protected-resources.ts";
import { resolvePermissions, resolveApiKeyPermissions } from "./permissions.ts";
import { getClientIp, propagateRequestClientIp } from "./client-ip.ts";
import { logger } from "./logger.ts";
import type { AppEnv } from "../types/index.ts";

export interface AuthPipelineOptions {
  /**
   * Accessor for paths that bypass the auth middleware entirely.
   * Module-contributed public paths (e.g. a module's inbound webhook
   * endpoint, OIDC login page) are merged into this set by the caller.
   * Wrapped in a function so the
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
 * Headers honored only under specific auth methods. Enforced once, centrally,
 * by the guard mounted in `applyAuthPipeline` — NOT per auth branch (the
 * per-branch checks drifted: cookie auth rejected `Appstrate-User` while the
 * module-strategy/OAuth branch silently ignored it).
 *
 * Headers NOT listed are deliberately left alone: per the HTTP robustness
 * principle (RFC 9110 §5.1) servers ignore unrecognized headers, and
 * blanket-rejecting unknown headers breaks proxies, tracing and middleboxes.
 * This guard only rejects a KNOWN header used under an auth method that cannot
 * honor it. Adding a new conditional header is one row here.
 */
const AUTH_CONDITIONAL_HEADERS: ReadonlyArray<{
  header: string;
  allowed: ReadonlySet<string>;
  code: string;
}> = [
  // `Appstrate-User` end-user impersonation is resolved only in the API-key
  // branch. Under any other auth method it has no effect, so reject it loudly
  // instead of silently ignoring it.
  { header: "Appstrate-User", allowed: new Set(["api_key"]), code: "header_not_allowed" },
];

/**
 * Mount the Better Auth handler and install the full auth middleware chain
 * on the given Hono app. Behavior must stay byte-identical between the
 * production and test harness callers — any change here must preserve the
 * order: module strategies → Bearer API key → cookie session.
 */
export function applyAuthPipeline(app: Hono<AppEnv>, opts: AuthPipelineOptions): void {
  const { publicPaths, authStrategies } = opts;

  // Resource-server auth-challenge responder: attaches a registered
  // `WWW-Authenticate` to a 401/403 on a matching path (RFC 9728 §5.1 / MCP
  // spec). Mounted first so it wraps both the auth 401 and route 403 below.
  // Generic + no-op when nothing is registered.
  app.use("*", authChallengeResponder());

  // Mount Better Auth handler — handles signup, signin, session, etc.
  //
  // Device-flow shim: RFC 8628 §3.2 specifies
  // `application/x-www-form-urlencoded` as the required content type for
  // `/device/code`, but Better Auth's `better-call` router currently
  // accepts only JSON. We rewrite form-urlencoded bodies into JSON on
  // the fly so the server is tolerant of BOTH content types (RFC-compliant
  // clients succeed, older JSON-sending binaries keep working). The same
  // shim covers the Appstrate-specific `/cli/token` and `/cli/revoke`
  // endpoints (issue #165). Tracked in
  // https://github.com/appstrate/appstrate/issues/166.
  app.on(["POST", "GET"], "/api/auth/*", async (c) => {
    const req = await maybeTransformDeviceFlowFormBody(c.req.raw);
    return getAuth().handler(req);
  });

  // Auth middleware: module strategies → Bearer API key → session cookie.
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, publicPaths(), c.req.raw.headers)) return next();

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
        if (resolution.firstPartyLoopback) {
          // Declared first-party loopback capability (server-minted, process-local
          // bearer). The bearer-only proxy gates read this instead of matching a
          // module's auth-method id. See apps/api/src/lib/bearer-only.ts.
          c.set("firstPartyLoopback", true);
        }
        if (resolution.extra && Object.keys(resolution.extra).length > 0) {
          // Strategy-specific opaque metadata. Consumers cast to the
          // shape they expect — keeping it untyped here avoids dragging
          // every strategy's extension keys into core types.
          c.set("authExtra", resolution.extra);
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
      // Bury the stale BA cookie before bouncing the request. Without this,
      // a cookie left behind by a redeploy (rotated `BETTER_AUTH_SECRET`,
      // wiped `session` rows, …) keeps re-arriving on every subsequent
      // request and the SPA loops between `/login` and `/auth/callback`
      // with no surfaceable error.
      clearStaleAuthCookies(c);
      throw unauthorized("Invalid or missing session");
    }

    // Appstrate-User rejection under cookie auth is enforced centrally by the
    // auth-conditional header guard below (see AUTH_CONDITIONAL_HEADERS), so it
    // cannot drift per-branch the way it previously did.

    c.set("user", {
      id: session.user.id,
      email: session.user.email ?? "",
      name: session.user.name ?? "",
    });
    c.set("authMethod", "session");
    // Resolve the user's realm so the realm guard middleware below can
    // reject cookie sessions minted for a non-platform audience (OIDC
    // end-users) from hitting platform routes. The realm is denormalized
    // onto the session row at create time (`databaseHooks.session.create
    // .before` + `session.additionalFields.realm` in packages/db/src/
    // auth.ts), and `cookieCache` is disabled, so `getSession` always
    // returns the fresh DB row with the declared additionalField — read
    // it from there instead of re-querying the user table on every
    // session-backed request. Fall back to the user-table lookup only
    // when the field is absent (sessions created before the
    // denormalization shipped, or a BA version stripping undeclared
    // output fields) so audience enforcement never silently degrades.
    const sessionRealm = (session.session as { realm?: unknown }).realm;
    if (typeof sessionRealm === "string") {
      c.set("sessionRealm", sessionRealm);
    } else {
      const [userRow] = await db
        .select({ realm: userTable.realm })
        .from(userTable)
        .where(eq(userTable.id, session.user.id))
        .limit(1);
      if (userRow) c.set("sessionRealm", userRow.realm);
    }

    return next();
  });

  // Auth-conditional header policy (see AUTH_CONDITIONAL_HEADERS). A known
  // header that is only meaningful under certain auth methods is rejected with
  // 400 when presented under any other — replacing the previous per-branch
  // checks that drifted. Runs after the auth middleware has resolved
  // `authMethod`, only for authenticated requests. Unlisted headers untouched.
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, publicPaths(), c.req.raw.headers)) return next();
    if (!c.get("user")) return next();
    const authMethod = c.get("authMethod");
    for (const { header, allowed, code } of AUTH_CONDITIONAL_HEADERS) {
      if (c.req.header(header) && (!authMethod || !allowed.has(authMethod))) {
        throw new ApiError({
          status: 400,
          code,
          title: "Header Not Allowed",
          detail: `${header} is only supported with ${[...allowed].join(", ")} auth, not ${authMethod ?? "this"} authentication.`,
          param: header,
        });
      }
    }
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
    if (skipAuth(c.req.path, publicPaths(), c.req.raw.headers)) return next();
    if (!c.get("user")) return next();
    return realmGuard(c, next);
  });

  // RFC 8707 audience confinement for OAuth bearer tokens. A token bound to a
  // protected resource (e.g. `/api/mcp/o/:org`) must be presented to that resource and
  // may not be replayed elsewhere — see `protected-resources.ts`. Runs after
  // auth (needs `authExtra.tokenAudiences`) but before org-context/permission
  // resolution, so an audience-mismatched token is rejected before any
  // resource work. No-op for cookie/API-key callers (no token audience) and
  // when no resource is registered.
  const resourceAudienceGuard = enforceResourceAudience();
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, publicPaths(), c.req.raw.headers)) return next();
    if (!c.get("user")) return next();
    return resourceAudienceGuard(c, next);
  });

  // Org context middleware: require X-Org-Id for org-scoped /api/* routes.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (skipAuth(path, publicPaths(), c.req.raw.headers)) return next();
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
 *
 * `headers` is optional and lets callers signal a request-scoped bypass
 * (e.g. pairing-token bearer auth on /pair/redeem) without polluting the
 * static `publicPaths` allowlist with conditionals.
 */
export function skipAuth(path: string, publicPaths: Set<string>, headers?: Headers): boolean {
  if (!path.startsWith("/api/")) return true;
  if (path.startsWith("/api/auth/")) return true; // Better Auth handles its own auth
  if (path.startsWith("/api/realtime/")) return true; // SSE endpoints use cookie auth internally
  if (path === "/api/integrations/callback") return true; // Integration OAuth redirect — no session
  // Hosted connect portal (issue #769) — token/page-cookie authenticated at the
  // route layer. The authed MINT route lives at
  // `/api/integrations/:packageId/auths/:authKey/connect/session` (packageId
  // prefix) and does NOT match this, so it keeps its session/permission guard.
  if (path.startsWith("/api/integrations/connect/")) return true;
  if (path === "/api/uploads/_content") return true; // FS direct-upload sink — auth via HMAC token
  if (path === "/api/docs" || path === "/api/openapi.json") return true;
  // Unified-runner run-scoped routes: event ingestion
  // (`/api/runs/:runId/events[/finalize|/heartbeat]`) and the agent
  // workspace self-provisioning fetches (`/api/runs/:runId/workspace`,
  // `/documents`, `/documents/:name`). All authenticate via a Standard
  // Webhooks HMAC signature at the route layer — not via JWT / API key /
  // cookie.
  if (REMOTE_RUN_EVENT_PATH_PATTERN.test(path)) return true;
  if (publicPaths.has(path)) return true; // module-contributed public paths
  // OAuth model-provider pair-redeem is bearer-only: `Authorization: Bearer appp_…`
  // is the ONLY accepted auth shape. The route handler atomically consumes
  // the matching `model_provider_pairings` row; the row's userId/orgId/
  // providerId become the request context, replacing the cookie/API-key
  // chain entirely. Requests without the bearer reach the route handler
  // and 401 there.
  if (path === "/api/model-providers-oauth/pair/redeem" && headers) {
    const auth = headers.get("authorization") ?? headers.get("Authorization");
    if (auth?.startsWith("Bearer appp_")) return true;
  }
  return false;
}

const REMOTE_RUN_EVENT_PATH_PATTERN =
  /^\/api\/runs\/[^/]+\/(events(\/finalize|\/heartbeat)?|workspace|documents(\/[^/]+)?)$/;

/**
 * Device-flow + CLI-token content-type shim.
 *
 * RFC 8628 specifies `application/x-www-form-urlencoded` at `/device/code`;
 * the 2.x CLI (issue #165) extends that convention to the `/cli/token`
 * and `/cli/revoke` endpoints it polls. Better Auth's `better-call` router
 * only accepts JSON, so if the incoming request targets any of those paths
 * with a form-urlencoded body we parse the body, rewrite it as JSON, and
 * return a fresh Request with `Content-Type: application/json`. All other
 * requests (including the existing JSON clients used by the integration
 * test suite) pass through unchanged.
 *
 * Exported for unit testing — the transform has no side effects.
 */
const FORM_TO_JSON_PATHS = new Set([
  "/api/auth/device/code",
  // Issue #165 — the 2.x CLI polls these endpoints with form-urlencoded
  // bodies for protocol parity with the RFC 8628 endpoint above. Without
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
  const replacement = new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(body),
    // Preserve non-body fields. Request has no `duplex` reflection, but we
    // already consumed the original body so the replacement is a complete
    // new request — no streaming to preserve.
  });
  // Carry the client IP across the Request reconstruction. The IP store
  // is keyed by Request identity (WeakMap), so without this propagation
  // downstream lookups in BA plugin endpoints would fall back to
  // `"unknown"` for every form-encoded device-flow request.
  propagateRequestClientIp(req, replacement);
  return replacement;
}

/** Paths that need auth but not org-context (user-scoped or self-resolving). */
export function skipOrgContext(path: string): boolean {
  if (path === "/api/orgs" || path === "/api/orgs/") return true; // list/create orgs
  if (path.startsWith("/api/orgs/")) return true; // /api/orgs/:id/* handle their own auth
  if (path === "/api/profile" || path === "/api/profile/") return true;
  // Same user-scoped rationale as `/api/profile` — setting a password is an
  // account operation, not an org operation.
  if (path === "/api/profile/password" || path === "/api/profile/password/") return true;
  if (path === "/api/welcome/setup") return true;
  // `/api/me/orgs` is the prerequisite to picking an org and setting
  // `X-Org-Id` — it cannot itself depend on org context being already
  // resolved. Other `/api/me/*` routes (e.g. `/api/me/models`) DO require
  // org context and are intentionally not listed here.
  if (path === "/api/me/orgs" || path === "/api/me/orgs/") return true;
  // `/api/me/connections` is the unified user-scope connection view: it
  // crosses orgs/applications by design, so requiring `X-Org-Id` would be
  // both wrong (no single org represents the caller's full inventory) and
  // user-hostile (would force the SPA to pick one before showing the list).
  if (path === "/api/me/connections" || path === "/api/me/connections/") return true;
  // `DELETE /api/me/connections/:id` — destructive global delete, derives
  // applicationId from the row itself. Same rationale as the list above.
  if (/^\/api\/me\/connections\/[^/]+\/?$/.test(path)) return true;
  // Desktop bridge (the `desktop` module) — a desktop companion belongs
  // to a person, not to an organization: the WS upgrade and the `/me/*`
  // surface are keyed by `userId` alone. Requiring `X-Org-Id` would force
  // the Electron client to pick an org it has no reason to know about.
  // Path-based, so harmless when the module is disabled (404 either way).
  if (path === "/api/desktop/bridge") return true;
  if (path.startsWith("/api/desktop/me/")) return true;
  return false;
}
