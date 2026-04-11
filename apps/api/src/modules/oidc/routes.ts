// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module — OAuth client admin routes.
 *
 * All routes are application-scoped (`X-App-Id` required, enforced by the
 * app-context middleware via `appScopedPaths: ["/api/oauth"]` in the module
 * manifest). Callers need `oauth-clients:*` permissions — a new resource
 * contributed to core in the same phase (CLAUDE.md rule: "if a module
 * introduces a new RBAC resource, extend `apps/api/src/lib/permissions.ts`
 * in the same PR").
 *
 * Phase 1 scope: CRUD + rotate. No token issuance from here — tokens are
 * issued by Better Auth's oauth-provider plugin under `/api/auth/oauth2/*`
 * (wired in Stage 5). These routes own the client registry only.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit, rateLimitByIp } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { parseBody, notFound, invalidRequest, forbidden } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getClientIp } from "../../lib/client-ip.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import { isDevEnvironment, LOCALHOST_HOSTS } from "../../services/redirect-validation.ts";
import { db } from "@appstrate/db/client";
import { user as betterAuthUser } from "@appstrate/db/schema";
import { oauthClient } from "./schema.ts";
import {
  listClientsForApp,
  getClient,
  createClient,
  deleteClient,
  rotateClientSecret,
  setClientDisabled,
  updateClientRedirectUris,
} from "./services/oauth-admin.ts";
import { resolveAppBranding } from "./services/branding.ts";
import { resolveOrCreateEndUser } from "./services/enduser-mapping.ts";
import { issueCsrfToken, verifyCsrfToken } from "./services/csrf.ts";
import { getOidcAuthApi } from "./auth/api.ts";
import { APPSTRATE_SCOPES } from "./auth/plugins.ts";
import { consumeLoginEmailAttempt, resetLoginEmailAttempts } from "./auth/guards.ts";
import { UnverifiedEmailConflictError } from "./services/enduser-mapping.ts";
import { renderLoginPage } from "./pages/login.ts";
import { renderConsentPage } from "./pages/consent.ts";

/**
 * Validate an OAuth `redirect_uri` candidate.
 *
 * Defense layers (in order):
 * 1. Must parse as an absolute URL.
 * 2. Scheme must be `https:` — `http:` is only allowed when pointing at
 *    `localhost`/`127.0.0.1` AND the platform itself is running in dev
 *    mode (`APP_URL` is HTTP/localhost). Production cannot register HTTP
 *    redirect URIs at all.
 * 3. Host must not resolve to a blocked network: SSRF targets (RFC1918,
 *    link-local `169.254.0.0/16`, cloud metadata, loopback in production,
 *    IPv6 variants), `javascript:`/`data:`/`file:` schemes. Enforced via
 *    `@appstrate/core/ssrf:isBlockedUrl`, which is the same helper used by
 *    the webhooks delivery path.
 *
 * Dev-mode localhost is explicitly re-allowed after the SSRF check so
 * satellites can register `http://localhost:5173/callback` etc. during
 * local development — only when `APP_URL` is itself a localhost URL.
 */
function isValidRedirectUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "https:") {
    return !isBlockedUrl(raw);
  }
  if (parsed.protocol === "http:" && isLocalhost && isDevEnvironment()) {
    return true;
  }
  return false;
}

const redirectUriSchema = z
  .url("redirectUris must be valid URLs")
  .refine(isValidRedirectUri, "redirectUri scheme or host is not allowed");

export const createOAuthClientSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  scopes: z.array(z.string().min(1)).optional(),
});

export const updateOAuthClientSchema = z.object({
  redirectUris: z.array(redirectUriSchema).min(1).optional(),
  disabled: z.boolean().optional(),
});

/**
 * Single entry point for every end-user page handler (GET/POST login,
 * GET/POST consent). Loads the oauth client row, rejects unknown/disabled
 * clients with 404, resolves the owning application's branding, and
 * issues a fresh CSRF token — all in one round trip per request.
 */
async function loadClientContext(
  c: Context<AppEnv>,
  clientId: string,
): Promise<{
  client: { id: string; name: string | null };
  applicationId: string | null;
  branding: Awaited<ReturnType<typeof resolveAppBranding>>;
  csrfToken: string;
}> {
  const [row] = await db
    .select({
      id: oauthClient.clientId,
      name: oauthClient.name,
      disabled: oauthClient.disabled,
      referenceId: oauthClient.referenceId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) throw notFound("Unknown OAuth client");
  const applicationId = row.referenceId ?? null;
  const branding = await resolveAppBranding(applicationId);
  const csrfToken = issueCsrfToken(c);
  return { client: { id: row.id, name: row.name }, applicationId, branding, csrfToken };
}

export function createOidcRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/oauth/clients — register a new OAuth client for the current app.
  // Returns the plaintext clientSecret exactly once (hashed at rest).
  router.post(
    "/oauth/clients",
    rateLimit(10),
    idempotency(),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const body = await c.req.json();
      const data = parseBody(createOAuthClientSchema, body);
      const created = await createClient(applicationId, data);
      return c.json(created, 201);
    },
  );

  // GET /api/oauth/clients — list registered clients for the current app.
  router.get(
    "/oauth/clients",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const data = await listClientsForApp(applicationId);
      return c.json({ object: "list", data });
    },
  );

  // GET /api/oauth/scopes — canonical scope vocabulary for the admin UI.
  // Read-only, org-member, no app context needed. The create-client modal
  // reads this list to render its checkbox group so the frontend never
  // hardcodes scope strings — adding a new scope to the server list is
  // enough to surface it in the UI.
  router.get(
    "/oauth/scopes",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      return c.json({ data: [...APPSTRATE_SCOPES] });
    },
  );

  // GET /api/oauth/clients/:clientId — retrieve a single client.
  router.get(
    "/oauth/clients/:clientId",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const client = await getClient(applicationId, c.req.param("clientId")!);
      if (!client) throw notFound("OAuth client not found");
      return c.json(client);
    },
  );

  // PATCH /api/oauth/clients/:clientId — update redirectUris or disabled flag.
  router.patch(
    "/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const clientId = c.req.param("clientId")!;
      const body = await c.req.json();
      const data = parseBody(updateOAuthClientSchema, body);

      let current = await getClient(applicationId, clientId);
      if (!current) throw notFound("OAuth client not found");

      if (data.redirectUris !== undefined) {
        current =
          (await updateClientRedirectUris(applicationId, clientId, data.redirectUris)) ?? current;
      }
      if (data.disabled !== undefined) {
        current = (await setClientDisabled(applicationId, clientId, data.disabled)) ?? current;
      }
      return c.json(current);
    },
  );

  // DELETE /api/oauth/clients/:clientId — remove a client.
  router.delete(
    "/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "delete"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const deleted = await deleteClient(applicationId, c.req.param("clientId")!);
      if (!deleted) throw notFound("OAuth client not found");
      return c.body(null, 204);
    },
  );

  // POST /api/oauth/clients/:clientId/rotate — issue a fresh clientSecret.
  router.post(
    "/oauth/clients/:clientId/rotate",
    rateLimit(5),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const rotated = await rotateClientSecret(applicationId, c.req.param("clientId")!);
      if (!rotated) throw notFound("OAuth client not found");
      return c.json(rotated);
    },
  );

  // ─── OIDC discovery aliases ────────────────────────────────────────────────
  //
  // Better Auth's oauth-provider plugin serves the authoritative OIDC metadata
  // under its own basePath (`/api/auth/.well-known/openid-configuration`).
  // The OIDC spec + most satellite libraries expect the document to live at
  // the root `/.well-known/openid-configuration` of the `issuer` URL, so we
  // expose the same payload at both the root and the module-scoped paths as
  // thin proxies. No CORS, no auth — this is a public, well-known endpoint.

  const proxyOidcMetadata = async (c: Context<AppEnv>) => {
    const payload = await getOidcAuthApi().getOpenIdConfig({ headers: c.req.raw.headers });
    c.header("cache-control", "public, max-age=3600");
    return c.json(payload as never);
  };

  const proxyOauthServerMetadata = async (c: Context<AppEnv>) => {
    const payload = await getOidcAuthApi().getOAuthServerConfig({ headers: c.req.raw.headers });
    c.header("cache-control", "public, max-age=3600");
    return c.json(payload as never);
  };

  router.get("/oauth/.well-known/openid-configuration", proxyOidcMetadata);
  router.get("/oauth/.well-known/oauth-authorization-server", proxyOauthServerMetadata);
  // Root aliases — Hono strips the `/api` prefix when mounted, so the core
  // router sees these as `/.well-known/*`. The module's `publicPaths` lists
  // both forms so the auth middleware lets them through in every scenario.
  router.get("/.well-known/openid-configuration", proxyOidcMetadata);
  router.get("/.well-known/oauth-authorization-server", proxyOauthServerMetadata);

  // ─── Public end-user pages (anonymous, listed in publicPaths) ──────────────

  // GET /api/oauth/enduser/login — server-rendered login form.
  // Validates the `client_id` query param against the registry so unknown
  // clients can't render the form at all (prevents phishing the HTML).
  // Loads the owning application's branding + issues a one-shot CSRF token
  // paired to an httpOnly cookie for the POST handler.
  router.get("/oauth/enduser/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

    const { branding, csrfToken } = await loadClientContext(c, clientId);
    const body = renderLoginPage({ queryString: url.search, branding, csrfToken });
    return c.html(body.value);
  });

  // POST /api/oauth/enduser/login — complete the email/password sign-in
  // against Better Auth, then redirect back into the oauth-provider flow
  // via `/api/auth/oauth2/authorize` preserving the original signed query.
  //
  // CSRF token paired with the `oidc_csrf` cookie (set on the GET) MUST
  // match exactly — mismatch → 403, no sign-in attempt made.
  router.post("/oauth/enduser/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

    const form = await c.req.parseBody();
    // CSRF is verified before any lookup so a forged POST never probes
    // the oauth_client table. The cookie is cleared on match; a fresh
    // token will be issued by `loadClientContext` below for whichever
    // response (error page or redirect) we return.
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      throw forbidden("CSRF token missing or invalid — reload the login page and try again");
    }

    const ctx = await loadClientContext(c, clientId);
    const renderError = (error: string, status: 400 | 401 | 409 | 429, email?: string) => {
      const page = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        error,
        email,
      });
      return c.html(page.value, status);
    };

    const email = readFormString(form, "email")?.toLowerCase().trim();
    const password = readFormString(form, "password");
    if (!email || !password) {
      return renderError("Email et mot de passe requis.", 400, email ?? undefined);
    }

    // Per-email brute-force protection — complements the IP limiter.
    // IP-only throttling lets distributed attackers hammer a single
    // account from many addresses.
    const attempt = await consumeLoginEmailAttempt(email);
    if (!attempt.allowed) {
      const minutes = Math.ceil(attempt.retryAfterSeconds / 60);
      c.header("Retry-After", String(attempt.retryAfterSeconds));
      return renderError(
        `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        429,
        email,
      );
    }

    // signInEmail sets the session cookie on the response. We `asResponse:
    // true` so we can forward the Set-Cookie header, then issue our own
    // 302 back into the authorize endpoint with the original signed query.
    // `request: c.req.raw` is required so Better Auth's endpoint wrapper
    // populates `ctx.request` — missing it causes plugins that check
    // `ctx.request` to throw 401 "request not found".
    const authApi = getOidcAuthApi();
    const authResponse = (await authApi.signInEmail({
      body: { email, password },
      request: c.req.raw,
      headers: c.req.raw.headers,
      asResponse: true,
    })) as Response;

    if (!authResponse.ok) {
      return renderError("Email ou mot de passe incorrect.", 401, email);
    }

    // Successful sign-in — clear the per-email attempt counter so the
    // next visitor to this account is not throttled by past failures.
    await resetLoginEmailAttempts(email);

    // Proactively resolve (or create) the Appstrate end-user *before*
    // redirecting into authorize, so an `UnverifiedEmailConflictError`
    // surfaces as a friendly FR error page on this handler rather than
    // as a generic 500 propagated through the plugin's token-mint path.
    // The original post-hoc catch at this call site was unreachable: the
    // error is actually thrown from `customAccessTokenClaims` during
    // token mint — *after* we have already 302'd away.
    //
    // We fetch the Better Auth user by email (unique index) because
    // `asResponse: true` above returns a raw Response, not the typed
    // `{ user }` object that the non-response form would give us.
    if (ctx.applicationId) {
      const [authUserRow] = await db
        .select({
          id: betterAuthUser.id,
          email: betterAuthUser.email,
          name: betterAuthUser.name,
          emailVerified: betterAuthUser.emailVerified,
        })
        .from(betterAuthUser)
        .where(eq(betterAuthUser.email, email))
        .limit(1);
      if (authUserRow) {
        try {
          await resolveOrCreateEndUser(
            {
              id: authUserRow.id,
              email: authUserRow.email,
              name: authUserRow.name,
              emailVerified: authUserRow.emailVerified === true,
            },
            ctx.applicationId,
          );
        } catch (err) {
          if (err instanceof UnverifiedEmailConflictError) {
            return renderError(
              "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
              409,
              email,
            );
          }
          throw err;
        }
      }
    }

    // Forward every Set-Cookie from Better Auth + redirect into authorize.
    const redirect = new Response(null, { status: 302 });
    for (const [name, value] of authResponse.headers) {
      if (name.toLowerCase() === "set-cookie") {
        redirect.headers.append("set-cookie", value);
      }
    }
    redirect.headers.set("location", `/api/auth/oauth2/authorize${url.search}`);
    return redirect;
  });

  // GET /api/oauth/enduser/consent — server-rendered consent form.
  router.get("/oauth/enduser/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    const scope = url.searchParams.get("scope") ?? "openid";
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

    const { client, branding, csrfToken } = await loadClientContext(c, clientId);
    const scopes = scope.split(/\s+/).filter(Boolean);
    const body = renderConsentPage({
      clientName: client.name ?? client.id,
      scopes,
      action: `/api/oauth/enduser/consent${url.search}`,
      branding,
      csrfToken,
    });
    return c.html(body.value);
  });

  // POST /api/oauth/enduser/consent — verify CSRF then forward to Better
  // Auth's `/oauth2/consent` endpoint with the signed `oauth_query` from
  // the authorize redirect. The plugin's before-hook reads `oauth_query`
  // from the body, verifies the HMAC signature against `ctx.context.secret`,
  // and rehydrates the pending authorization state into `oAuthState` so the
  // consent endpoint can mint the authorization code.
  //
  // The signed query lands here via `url.search`: our GET /consent handler
  // echoes `url.search` into the form action, so the browser POSTs back to
  // the same path with the signed query still attached. We strip the leading
  // `?` and forward the remainder as `oauth_query`. Anything we injected
  // ourselves (e.g. internal params) would break the signature — we don't
  // add any, so the round-trip is verbatim.
  router.post("/oauth/enduser/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);

    const form = await c.req.parseBody();
    const csrfOk = verifyCsrfToken(c, readFormString(form, "_csrf"));
    if (!csrfOk) {
      throw forbidden("CSRF token missing or invalid — reload the consent page and try again");
    }

    const accept = readFormString(form, "accept") === "true";
    const oauthQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    if (!oauthQuery) {
      throw invalidRequest(
        "consent page must be reached from the OAuth authorize endpoint — missing signed query",
      );
    }

    // Audit log — record the decision before forwarding to Better Auth.
    // The signed query carries the full OAuth2 context (client_id, scope,
    // redirect_uri) which was HMAC-verified by the consent endpoint's own
    // before-hook on the way in, so we can trust its contents here. The
    // `audit: true` marker is the filter downstream log shippers use to
    // forward consent events to SIEM / compliance storage.
    const consentParams = new URLSearchParams(oauthQuery);
    logger.info("oidc: consent decision", {
      module: "oidc",
      audit: true,
      decision: accept ? "accept" : "deny",
      clientId: consentParams.get("client_id") ?? undefined,
      scope: consentParams.get("scope") ?? undefined,
      redirectUri: consentParams.get("redirect_uri") ?? undefined,
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      requestId: c.get("requestId"),
    });

    const authApi = getOidcAuthApi();
    const consentResponse = (await authApi.oauth2Consent({
      body: {
        accept,
        oauth_query: oauthQuery,
      },
      // Better Auth's endpoint wrapper (`to-auth-endpoints.mjs`) checks
      // `context.request instanceof Request` and the oauth-provider plugin
      // throws "request not found" (401) inside `authorizeEndpoint` if it
      // is missing — pass the raw Hono request through so `ctx.request` is
      // populated end-to-end.
      request: c.req.raw,
      headers: c.req.raw.headers,
      asResponse: true,
    })) as Response;

    // Browser form submits (our server-rendered consent page) must see a
    // real HTTP redirect — otherwise the browser renders the JSON
    // `{redirect:true,url:"..."}` body as the new document. Programmatic
    // callers (tests, JSON API clients) keep the verbatim JSON shape.
    const acceptsHtml = prefersHtml(c.req.header("accept"));
    return maybeJsonRedirectToLocation(consentResponse, acceptsHtml);
  });

  return router;
}

/**
 * Detect whether an `Accept` header prefers HTML over JSON. Used by the
 * consent handler to decide whether to materialize Better Auth's JSON
 * redirect response into a real 302 (for browser form submits) or pass it
 * through verbatim (for programmatic JSON callers).
 */
export function prefersHtml(acceptHeader: string | undefined | null): boolean {
  if (!acceptHeader) return false;
  const lower = acceptHeader.toLowerCase();
  if (lower.includes("application/json")) return false;
  return lower.includes("text/html") || lower.includes("*/*");
}

/**
 * Convert a Better Auth `oauth2Consent` JSON redirect response into a real
 * HTTP 302 when the caller prefers HTML, preserving any `Set-Cookie`
 * headers the plugin attached. Already-302 responses and non-JSON bodies
 * are passed through unchanged. Programmatic JSON callers (`acceptsHtml`
 * false) always see the verbatim plugin response so existing tests and
 * API clients keep working.
 *
 * Better Auth returns one of: `{ redirect: true, url: "..." }`,
 * `{ redirect_uri: "..." }`, `{ redirectURI: "..." }`, or `{ url: "..." }`
 * depending on plugin version — accept all shapes.
 */
export async function maybeJsonRedirectToLocation(
  response: Response,
  acceptsHtml: boolean,
): Promise<Response> {
  if (!acceptsHtml) return response;
  if (response.status === 302 || response.status === 303) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!body || typeof body !== "object") return response;
  const obj = body as Record<string, unknown>;
  const target =
    (typeof obj.url === "string" && obj.url) ||
    (typeof obj.redirect_uri === "string" && obj.redirect_uri) ||
    (typeof obj.redirectURI === "string" && obj.redirectURI) ||
    null;
  if (!target) return response;

  const redirect = new Response(null, { status: 302 });
  redirect.headers.set("location", target);
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") {
      redirect.headers.append("set-cookie", value);
    }
  }
  return redirect;
}

/**
 * Extract a string field from a Hono-parsed form body, ignoring arrays /
 * file uploads. Keeps the POST handlers above concise.
 */
function readFormString(
  form: Record<string, string | File | (string | File)[]>,
  key: string,
): string | undefined {
  const value = form[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}
