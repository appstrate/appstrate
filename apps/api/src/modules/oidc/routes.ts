// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module — OAuth client admin routes + server-rendered login/consent pages.
 *
 * Polymorphic across two client types:
 *   - `dashboard`: org-scoped OAuth client for dashboard users (org operators)
 *   - `end_user`: application-scoped OAuth client for app end-users
 *
 * The admin CRUD uses `z.discriminatedUnion("clientType", …)` for creation
 * so the request body is statically typed on the discriminant. The
 * server-rendered `/api/oauth/{login,consent}` pages are polymorphic: they
 * load the client, resolve branding via `resolveBrandingForClient`, and
 * render the form identically — only the post-login handling diverges
 * (dashboard tokens skip `resolveOrCreateEndUser`; end-user tokens run it).
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit, rateLimitByIp } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { parseBody, notFound, invalidRequest, forbidden } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getClientIp } from "../../lib/client-ip.ts";
import { db } from "@appstrate/db/client";
import { user, applications, organizationMembers } from "@appstrate/db/schema";
import { oauthClient } from "./schema.ts";
import {
  createClient,
  deleteClient,
  getClient,
  getClientOwningOrg,
  listClientsForOrgAndApps,
  rotateClientSecret,
  updateClient,
  OAuthAdminValidationError,
} from "./services/oauth-admin.ts";
import { isValidRedirectUri } from "./services/redirect-uri.ts";
import { resolveBrandingForClient } from "./services/branding.ts";
import { issueCsrfToken, verifyCsrfToken } from "./services/csrf.ts";
import { getOidcAuthApi } from "./auth/api.ts";
import { APPSTRATE_SCOPES } from "./auth/scopes.ts";
import { consumeLoginEmailAttempt, resetLoginEmailAttempts } from "./auth/guards.ts";
import {
  UnverifiedEmailConflictError,
  resolveOrCreateEndUser,
  loadAppById,
} from "./services/enduser-mapping.ts";
import { renderLoginPage } from "./pages/login.ts";
import { renderConsentPage } from "./pages/consent.ts";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const redirectUriSchema = z
  .url("redirectUris must be valid URLs")
  .refine(isValidRedirectUri, "redirectUri scheme or host is not allowed");

const createOrgClientSchema = z.object({
  level: z.literal("org"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  scopes: z.array(z.string().min(1)).optional(),
  referencedOrgId: z.string().min(1),
  isFirstParty: z.boolean().optional(),
});

const createApplicationClientSchema = z.object({
  level: z.literal("application"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  scopes: z.array(z.string().min(1)).optional(),
  referencedApplicationId: z.string().min(1),
  isFirstParty: z.boolean().optional(),
});

export const createOAuthClientSchema = z.discriminatedUnion("level", [
  createOrgClientSchema,
  createApplicationClientSchema,
]);

export const updateOAuthClientSchema = z.object({
  redirectUris: z.array(redirectUriSchema).min(1).optional(),
  disabled: z.boolean().optional(),
  isFirstParty: z.boolean().optional(),
});

// ─── Shared page context loader ───────────────────────────────────────────────

interface ClientContext {
  client: {
    id: string;
    name: string | null;
    level: "org" | "application";
    referencedOrgId: string | null;
    referencedApplicationId: string | null;
  };
  branding: Awaited<ReturnType<typeof resolveBrandingForClient>>;
  csrfToken: string;
}

async function loadClientContext(c: Context<AppEnv>, clientId: string): Promise<ClientContext> {
  const [row] = await db
    .select({
      id: oauthClient.clientId,
      name: oauthClient.name,
      disabled: oauthClient.disabled,
      level: oauthClient.level,
      referencedOrgId: oauthClient.referencedOrgId,
      referencedApplicationId: oauthClient.referencedApplicationId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) throw notFound("Unknown OAuth client");
  const level = row.level === "org" ? "org" : "application";
  const client = {
    id: row.id,
    name: row.name,
    level: level as "org" | "application",
    referencedOrgId: row.referencedOrgId,
    referencedApplicationId: row.referencedApplicationId,
  };
  const branding = await resolveBrandingForClient(client);
  const csrfToken = issueCsrfToken(c);
  return { client, branding, csrfToken };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createOidcRouter() {
  const router = new Hono<AppEnv>();

  // ── Admin: CRUD ─────────────────────────────────────────────────────────────

  router.post(
    "/api/oauth/clients",
    rateLimit(10),
    idempotency(),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(createOAuthClientSchema, body);

      // Authorization: the caller must own the referenced entity.
      if (data.level === "org") {
        if (data.referencedOrgId !== orgId) {
          throw forbidden("referencedOrgId must match the current organization");
        }
      } else {
        // application-level: the application must belong to the caller's org.
        const [app] = await db
          .select({ orgId: applications.orgId })
          .from(applications)
          .where(eq(applications.id, data.referencedApplicationId))
          .limit(1);
        if (!app || app.orgId !== orgId) {
          throw forbidden("referencedApplicationId must belong to the current organization");
        }
      }

      try {
        const created = await createClient(data);
        return c.json(created, 201);
      } catch (err) {
        if (err instanceof OAuthAdminValidationError) {
          throw invalidRequest(err.message, err.field);
        }
        throw err;
      }
    },
  );

  // Combined list: org-level clients for the org + application-level clients
  // for every app the org owns. The admin UI renders both in one table.
  router.get(
    "/api/oauth/clients",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const appRows = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.orgId, orgId));
      const clients = await listClientsForOrgAndApps(
        orgId,
        appRows.map((a) => a.id),
      );
      return c.json({ object: "list", data: clients });
    },
  );

  router.get(
    "/api/oauth/scopes",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => c.json({ data: [...APPSTRATE_SCOPES] }),
  );

  router.get(
    "/api/oauth/clients/:clientId",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const client = await getClient(c.req.param("clientId")!);
      if (!client) throw notFound("OAuth client not found");
      const owning = await getClientOwningOrg(client.clientId);
      if (owning !== orgId) throw notFound("OAuth client not found");
      return c.json(client);
    },
  );

  router.patch(
    "/api/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const clientId = c.req.param("clientId")!;
      const body = await c.req.json();
      const data = parseBody(updateOAuthClientSchema, body);
      const owning = await getClientOwningOrg(clientId);
      if (owning !== orgId) throw notFound("OAuth client not found");

      // Require admin/owner for isFirstParty — skipping consent is a trust escalation.
      if (data.isFirstParty !== undefined) {
        const orgRole = c.get("orgRole");
        if (orgRole !== "owner" && orgRole !== "admin") {
          throw forbidden("Only org admins can set isFirstParty");
        }
      }

      try {
        const updated = await updateClient(clientId, data);
        if (!updated) throw notFound("OAuth client not found");
        return c.json(updated);
      } catch (err) {
        if (err instanceof OAuthAdminValidationError) {
          throw invalidRequest(err.message, err.field);
        }
        throw err;
      }
    },
  );

  router.delete(
    "/api/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "delete"),
    async (c) => {
      const orgId = c.get("orgId");
      const clientId = c.req.param("clientId")!;
      const owning = await getClientOwningOrg(clientId);
      if (owning !== orgId) throw notFound("OAuth client not found");
      const deleted = await deleteClient(clientId);
      if (!deleted) throw notFound("OAuth client not found");
      return c.body(null, 204);
    },
  );

  router.post(
    "/api/oauth/clients/:clientId/rotate",
    rateLimit(5),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const clientId = c.req.param("clientId")!;
      const owning = await getClientOwningOrg(clientId);
      if (owning !== orgId) throw notFound("OAuth client not found");
      const rotated = await rotateClientSecret(clientId);
      if (!rotated) throw notFound("OAuth client not found");
      return c.json(rotated);
    },
  );

  // ── Public polymorphic login/consent pages ─────────────────────────────────

  router.get("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) throw invalidRequest("client_id is required", "client_id");
    const { branding, csrfToken } = await loadClientContext(c, clientId);
    const body = renderLoginPage({ queryString: url.search, branding, csrfToken });
    return c.html(body.value);
  });

  router.post("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      throw forbidden("CSRF token missing or invalid — reload the login page and try again");
    }

    const ctx = await loadClientContext(c, clientId);
    const renderError = (error: string, status: 400 | 401 | 403 | 409 | 429, email?: string) => {
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

    const authApi = getOidcAuthApi();
    let authResponse: Response;
    try {
      authResponse = (await authApi.signInEmail({
        body: { email, password },
        headers: c.req.raw.headers,
        asResponse: true,
      })) as Response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("oidc: signInEmail threw", { error: msg, email });
      return renderError("Email ou mot de passe incorrect.", 401, email);
    }

    if (!authResponse.ok) {
      const bodyText = await authResponse.text().catch(() => "");
      logger.warn("oidc: signInEmail !ok", {
        status: authResponse.status,
        body: bodyText.slice(0, 400),
        email,
      });
      return renderError("Email ou mot de passe incorrect.", 401, email);
    }

    await resetLoginEmailAttempts(email);

    // For org-level clients: proactively verify the signed-in user is a
    // member of the pinned organization. Otherwise the failure surfaces as
    // an opaque 500 from inside `customAccessTokenClaims` after three
    // redirects — unhelpful and confusing.
    if (ctx.client.level === "org" && ctx.client.referencedOrgId) {
      const [authUserRow] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (authUserRow) {
        const [m] = await db
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, authUserRow.id),
              eq(organizationMembers.orgId, ctx.client.referencedOrgId),
            ),
          )
          .limit(1);
        if (!m) {
          return renderError(
            "Ce compte n'est pas membre de l'organisation associée à cette application. Contactez votre administrateur.",
            403,
            email,
          );
        }
      }
    }

    // For application-level clients: proactively resolve-or-create the
    // end-user row so `UnverifiedEmailConflictError` surfaces as a 409 here
    // rather than as an opaque 500 three redirects deep at token-mint time.
    // Org-level clients skip this — they don't create end_users rows.
    if (ctx.client.level === "application" && ctx.client.referencedApplicationId) {
      const [authUserRow] = await db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
        })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (authUserRow) {
        const app = await loadAppById(ctx.client.referencedApplicationId);
        if (app) {
          try {
            await resolveOrCreateEndUser(
              {
                id: authUserRow.id,
                email: authUserRow.email,
                name: authUserRow.name ?? null,
                emailVerified: authUserRow.emailVerified === true,
              },
              app,
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
    }

    // Headers.getSetCookie() returns each Set-Cookie as a distinct entry —
    // plain iteration collapses duplicate headers into a comma-joined string
    // which breaks cookie forwarding. We must use the Hono context header
    // accumulator (not a fresh Response) so the forwarded cookies survive
    // alongside the CSRF cookie deletion that verifyCsrfToken already queued.
    const setCookies =
      typeof (authResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
      "function"
        ? (authResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const value of setCookies) {
      c.header("set-cookie", value, { append: true });
    }
    logger.info("oidc: login success, forwarding cookies", {
      cookieCount: setCookies.length,
      email,
    });
    return c.redirect(`/api/auth/oauth2/authorize${url.search}`, 302);
  });

  router.get("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    const scope = url.searchParams.get("scope") ?? "openid";
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

    const { client, branding, csrfToken } = await loadClientContext(c, clientId);
    const scopes = scope.split(/\s+/).filter(Boolean);
    const body = renderConsentPage({
      clientName: client.name ?? client.id,
      scopes,
      action: `/api/oauth/consent${url.search}`,
      branding,
      csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      throw forbidden("CSRF token missing or invalid — reload the consent page and try again");
    }

    const accept = readFormString(form, "accept") === "true";
    const oauthQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    if (!oauthQuery) {
      throw invalidRequest(
        "consent page must be reached from the OAuth authorize endpoint — missing signed query",
      );
    }

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
    let consentResponse: Response;
    try {
      consentResponse = (await authApi.oauth2Consent({
        body: { accept, oauth_query: oauthQuery },
        request: c.req.raw,
        headers: c.req.raw.headers,
        asResponse: true,
      })) as Response;
    } catch (err) {
      if (err instanceof UnverifiedEmailConflictError) {
        const clientIdParam = consentParams.get("client_id");
        if (clientIdParam) {
          const ctx = await loadClientContext(c, clientIdParam);
          const page = renderLoginPage({
            queryString: `?${oauthQuery}`,
            branding: ctx.branding,
            csrfToken: ctx.csrfToken,
            error:
              "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
          });
          return c.html(page.value, 409);
        }
      }
      throw err;
    }

    const acceptsHtml = prefersHtml(c.req.header("accept"));
    return maybeJsonRedirectToLocation(consentResponse, acceptsHtml);
  });

  // ── RP-Initiated Logout helper ───────────────────────────────────────────────
  // Better Auth's /oauth2/end-session deletes the session from the DB
  // but does NOT clear the `better-auth.session_token` cookie. This
  // leaves a stale cookie that breaks the next authorize request
  // ("session no longer exists"). This custom GET route clears the
  // cookie and redirects to the post_logout_redirect_uri.
  // Satellites call this instead of /oauth2/end-session directly.

  router.get("/api/oauth/logout", rateLimitByIp(30), async (c: Context<AppEnv>) => {
    const postLogoutUri = c.req.query("post_logout_redirect_uri");
    const clientId = c.req.query("client_id");

    // Clear the BA session cookie so the next authorize starts fresh.
    c.header("set-cookie", "better-auth.session_token=; Path=/; HttpOnly; Max-Age=0", {
      append: true,
    });

    // Validate redirect URI against the client's registered URIs to prevent
    // open redirect attacks (OWASP). Fall back to "/" if no URI or no client.
    if (postLogoutUri && clientId) {
      const client = await getClient(clientId);
      if (client) {
        const registeredUris = client.redirectUris ?? [];
        if (registeredUris.includes(postLogoutUri)) {
          return c.redirect(postLogoutUri, 302);
        }
      }
    }

    return c.redirect("/", 302);
  });

  // ── OIDC discovery ──────────────────────────────────────────────────────────

  router.get("/.well-known/openid-configuration", async (c: Context<AppEnv>) => {
    const payload = await getOidcAuthApi().getOpenIdConfig({ headers: c.req.raw.headers });
    c.header("cache-control", "public, max-age=3600");
    return c.json(payload as never);
  });
  router.get("/.well-known/oauth-authorization-server", async (c: Context<AppEnv>) => {
    const payload = await getOidcAuthApi().getOAuthServerConfig({ headers: c.req.raw.headers });
    c.header("cache-control", "public, max-age=3600");
    return c.json(payload as never);
  });

  return router;
}

export function prefersHtml(acceptHeader: string | undefined | null): boolean {
  if (!acceptHeader) return false;
  const lower = acceptHeader.toLowerCase();
  if (lower.includes("application/json")) return false;
  return lower.includes("text/html") || lower.includes("*/*");
}

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
  const target = (body as { url?: unknown }).url;
  if (typeof target !== "string") return response;

  const redirect = new Response(null, { status: 302 });
  redirect.headers.set("location", target);
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") {
      redirect.headers.append("set-cookie", value);
    }
  }
  return redirect;
}

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
