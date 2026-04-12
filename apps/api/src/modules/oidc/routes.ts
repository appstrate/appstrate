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
import { getEnv } from "@appstrate/env";
import { renderLoginPage } from "./pages/login.ts";
import { renderRegisterPage } from "./pages/register.ts";
import { renderConsentPage } from "./pages/consent.ts";
import { renderErrorPage } from "./pages/error.ts";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const redirectUriSchema = z
  .url("redirectUris must be valid URLs")
  .refine(isValidRedirectUri, "redirectUri scheme or host is not allowed");

const createOrgClientSchema = z.object({
  level: z.literal("org"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  postLogoutRedirectUris: z.array(redirectUriSchema).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  referencedOrgId: z.string().min(1),
  isFirstParty: z.boolean().optional(),
});

const createApplicationClientSchema = z.object({
  level: z.literal("application"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  postLogoutRedirectUris: z.array(redirectUriSchema).optional(),
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
  postLogoutRedirectUris: z.array(redirectUriSchema).optional(),
  disabled: z.boolean().optional(),
  isFirstParty: z.boolean().optional(),
});

// ─── Shared page context loader ───────────────────────────────────────────────

interface ClientContext {
  client: {
    id: string;
    name: string | null;
    level: "org" | "application" | "instance";
    referencedOrgId: string | null;
    referencedApplicationId: string | null;
    isFirstParty: boolean;
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
      isFirstParty: oauthClient.skipConsent,
      referencedOrgId: oauthClient.referencedOrgId,
      referencedApplicationId: oauthClient.referencedApplicationId,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) throw notFound("Unknown OAuth client");
  const level = row.level as "org" | "application" | "instance";
  const client = {
    id: row.id,
    name: row.name,
    level,
    isFirstParty: row.isFirstParty === true,
    referencedOrgId: row.referencedOrgId,
    referencedApplicationId: row.referencedApplicationId,
  };
  const branding = await resolveBrandingForClient(client);
  const csrfToken = issueCsrfToken(c);
  return { client, branding, csrfToken };
}

/**
 * Wrapper around `loadClientContext` for public browser-facing routes.
 * Returns `null` (+ renders an error page) instead of throwing `notFound`
 * so the user sees styled HTML — not raw JSON.
 */
async function loadClientContextOrRenderError(
  c: Context<AppEnv>,
  clientId: string,
): Promise<ClientContext | Response> {
  try {
    return await loadClientContext(c, clientId);
  } catch {
    return c.html(
      renderErrorPage({
        title: "Application introuvable",
        message:
          "L'application associée à ce lien n'existe plus ou a été désactivée. Contactez l'administrateur de l'application.",
      }).value,
      404,
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detect available social auth providers from env vars. */
function getSocialProviders(): { google: boolean; github: boolean } {
  const env = getEnv();
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}

function isSmtpEnabled(): boolean {
  const env = getEnv();
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

/** Skipping consent is a trust escalation — only admin/owner may set isFirstParty. */
function requireAdminForFirstParty(c: Context<AppEnv>, isFirstParty: boolean | undefined) {
  if (isFirstParty) {
    const orgRole = c.get("orgRole");
    if (orgRole !== "owner" && orgRole !== "admin") {
      throw forbidden("Only org admins can set isFirstParty");
    }
  }
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

      requireAdminForFirstParty(c, data.isFirstParty);

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
      if (!owning || owning !== orgId) throw notFound("OAuth client not found");
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
      if (!owning || owning !== orgId) throw notFound("OAuth client not found");

      requireAdminForFirstParty(c, data.isFirstParty);

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
      if (!owning || owning !== orgId) throw notFound("OAuth client not found");
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
      if (!owning || owning !== orgId) throw notFound("OAuth client not found");
      const rotated = await rotateClientSecret(clientId);
      if (!rotated) throw notFound("OAuth client not found");
      return c.json(rotated);
    },
  );

  // ── Public polymorphic login/consent pages ─────────────────────────────────

  router.get("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) {
      return c.html(
        renderErrorPage({
          title: "Lien de connexion invalide",
          message:
            "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
        }).value,
        400,
      );
    }
    // Better Auth signs the redirect with `exp` (Unix seconds). Reject
    // expired login URLs so stale links cannot create upstream sessions.
    const exp = url.searchParams.get("exp");
    if (exp && Number(exp) < Date.now() / 1000) {
      const result = await loadClientContextOrRenderError(c, clientId);
      if (result instanceof Response) return result;
      const body = renderLoginPage({
        queryString: url.search,
        branding: result.branding,
        csrfToken: "",
        socialProviders: getSocialProviders(),
        smtpEnabled: isSmtpEnabled(),
        error:
          "Ce lien de connexion a expiré. Veuillez relancer la connexion depuis l'application.",
      });
      return c.html(body.value, 400);
    }
    const getResult = await loadClientContextOrRenderError(c, clientId);
    if (getResult instanceof Response) return getResult;
    const body = renderLoginPage({
      queryString: url.search,
      branding: getResult.branding,
      csrfToken: getResult.csrfToken,
      socialProviders: getSocialProviders(),
      smtpEnabled: isSmtpEnabled(),
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) {
      return c.html(
        renderErrorPage({
          title: "Lien de connexion invalide",
          message:
            "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
        }).value,
        400,
      );
    }
    // Reject form submissions for expired login URLs — prevents creating a
    // Better Auth session from a stale link. Render the login page with an
    // inline error (same as the GET handler) instead of returning JSON —
    // the browser submitted a form, not an API call.
    const exp = url.searchParams.get("exp");
    if (exp && Number(exp) < Date.now() / 1000) {
      const result = await loadClientContextOrRenderError(c, clientId);
      if (result instanceof Response) return result;
      const body = renderLoginPage({
        queryString: url.search,
        branding: result.branding,
        csrfToken: "",
        socialProviders: getSocialProviders(),
        smtpEnabled: isSmtpEnabled(),
        error:
          "Ce lien de connexion a expiré. Veuillez relancer la connexion depuis l'application.",
      });
      return c.html(body.value, 400);
    }

    const form = await c.req.parseBody();
    const ctxResult = await loadClientContextOrRenderError(c, clientId);
    if (ctxResult instanceof Response) return ctxResult;
    const ctx = ctxResult;
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      const page = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: getSocialProviders(),
        smtpEnabled: isSmtpEnabled(),
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(page.value, 403);
    }
    const socialProviders = getSocialProviders();
    const smtpEnabled = isSmtpEnabled();
    const renderError = (
      error: string,
      status: 400 | 401 | 403 | 409 | 429 | 500,
      email?: string,
    ) => {
      const page = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders,
        smtpEnabled,
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
      // Distinguish infrastructure failures from bad credentials. Connection
      // errors, DB timeouts, and unhandled 5xx should not masquerade as
      // "wrong password" — the user would retry endlessly.
      const isInfraError =
        err instanceof Error &&
        (/connect|ECONNREFUSED|timeout|database|pool/i.test(err.message) ||
          ("status" in err && typeof err.status === "number" && err.status >= 500));
      if (isInfraError) {
        logger.error("oidc: signInEmail infra error", { error: msg, email });
        return renderError("Erreur serveur temporaire, veuillez réessayer.", 500, email);
      }
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
    //
    // SECURITY: Cap the session cookie Max-Age to 5 minutes for third-party
    // clients. The BA session is only needed for the OAuth redirect chain
    // (login → authorize → consent → callback). Without this cap, the
    // session persists indefinitely — if the downstream client rejects the
    // callback (e.g. expired state), the surviving BA session enables
    // silent re-authentication, bypassing the client's CSRF protection.
    //
    // Exception: first-party clients (e.g. the platform SPA) keep the
    // default session TTL because the session IS the primary auth mechanism
    // — the OIDC flow is only used to route through the shared login page.
    const OAUTH_SESSION_MAX_AGE = 300; // 5 minutes — enough for the redirect chain
    const setCookies =
      typeof (authResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
      "function"
        ? (authResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const raw of setCookies) {
      if (ctx.client.isFirstParty) {
        // First-party: forward cookies as-is (default 7-day session TTL)
        c.header("set-cookie", raw, { append: true });
      } else {
        // Third-party: cap to 5 minutes for the OAuth redirect chain only
        const patched = raw.includes("Max-Age=")
          ? raw.replace(/Max-Age=\d+/gi, `Max-Age=${OAUTH_SESSION_MAX_AGE}`)
          : `${raw}; Max-Age=${OAUTH_SESSION_MAX_AGE}`;
        c.header("set-cookie", patched, { append: true });
      }
    }
    logger.info("oidc: login success, forwarding cookies", {
      cookieCount: setCookies.length,
      firstParty: ctx.client.isFirstParty,
      email,
    });
    return c.redirect(`/api/auth/oauth2/authorize${url.search}`, 302);
  });

  // ── Public registration page ──────────────────────────────────────────────

  router.get("/api/oauth/register", rateLimitByIp(30), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) {
      return c.html(
        renderErrorPage({
          title: "Lien d'inscription invalide",
          message:
            "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
        }).value,
        400,
      );
    }
    const result = await loadClientContextOrRenderError(c, clientId);
    if (result instanceof Response) return result;
    const body = renderRegisterPage({
      queryString: url.search,
      branding: result.branding,
      csrfToken: result.csrfToken,
      socialProviders: getSocialProviders(),
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/register", rateLimitByIp(20), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) {
      return c.html(
        renderErrorPage({
          title: "Lien d'inscription invalide",
          message:
            "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
        }).value,
        400,
      );
    }
    const ctxResult = await loadClientContextOrRenderError(c, clientId);
    if (ctxResult instanceof Response) return ctxResult;
    const ctx = ctxResult;

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      const page = renderRegisterPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: getSocialProviders(),
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(page.value, 403);
    }

    const renderRegError = (
      error: string,
      status: 400 | 409 | 429 | 500,
      email?: string,
      name?: string,
    ) => {
      const page = renderRegisterPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: getSocialProviders(),
        error,
        email,
        name,
      });
      return c.html(page.value, status);
    };

    const name = readFormString(form, "name")?.trim();
    const email = readFormString(form, "email")?.toLowerCase().trim();
    const password = readFormString(form, "password");
    if (!name || !email || !password) {
      return renderRegError("Tous les champs sont requis.", 400, email ?? undefined, name);
    }
    if (password.length < 8) {
      return renderRegError(
        "Le mot de passe doit contenir au moins 8 caractères.",
        400,
        email,
        name,
      );
    }

    const authApi = getOidcAuthApi();
    let authResponse: Response;
    try {
      authResponse = (await authApi.signUpEmail({
        body: { email, password, name },
        headers: c.req.raw.headers,
        asResponse: true,
      })) as Response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("oidc: signUpEmail failed", { error: msg, email });
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        return renderRegError(
          "Un compte existe déjà avec cet email. Essayez de vous connecter.",
          409,
          email,
          name,
        );
      }
      return renderRegError("Erreur serveur temporaire, veuillez réessayer.", 500, email, name);
    }

    if (!authResponse.ok) {
      const bodyText = await authResponse.text().catch(() => "");
      logger.warn("oidc: signUpEmail !ok", {
        status: authResponse.status,
        body: bodyText.slice(0, 400),
        email,
      });
      if (authResponse.status === 422 || bodyText.includes("already exists")) {
        return renderRegError(
          "Un compte existe déjà avec cet email. Essayez de vous connecter.",
          409,
          email,
          name,
        );
      }
      return renderRegError(
        "Impossible de créer le compte. Vérifiez vos informations.",
        400,
        email,
        name,
      );
    }

    // Forward session cookies — same pattern as login POST handler
    const setCookies =
      typeof (authResponse.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
      "function"
        ? (authResponse.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const raw of setCookies) {
      if (ctx.client.isFirstParty) {
        c.header("set-cookie", raw, { append: true });
      } else {
        const OAUTH_SESSION_MAX_AGE = 300;
        const patched = raw.includes("Max-Age=")
          ? raw.replace(/Max-Age=\d+/gi, `Max-Age=${OAUTH_SESSION_MAX_AGE}`)
          : `${raw}; Max-Age=${OAUTH_SESSION_MAX_AGE}`;
        c.header("set-cookie", patched, { append: true });
      }
    }

    logger.info("oidc: registration success", { email });
    return c.redirect(`/api/auth/oauth2/authorize${url.search}`, 302);
  });

  router.get("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    const scope = url.searchParams.get("scope") ?? "openid";
    if (!clientId) {
      return c.html(
        renderErrorPage({
          title: "Page d'autorisation invalide",
          message:
            "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
        }).value,
        400,
      );
    }

    const consentResult = await loadClientContextOrRenderError(c, clientId);
    if (consentResult instanceof Response) return consentResult;

    // First-party clients skip the consent screen — the user already trusts
    // the platform SPA or an admin-designated first-party app.
    if (consentResult.client.isFirstParty) {
      const oauthQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
      const authApi = getOidcAuthApi();
      try {
        const consentResponse = (await authApi.oauth2Consent({
          body: { accept: true, oauth_query: oauthQuery },
          request: c.req.raw,
          headers: c.req.raw.headers,
          asResponse: true,
        })) as Response;
        return maybeJsonRedirectToLocation(consentResponse, true);
      } catch (err) {
        if (err instanceof UnverifiedEmailConflictError) {
          const page = renderErrorPage({
            title: "Vérification requise",
            message:
              "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
          });
          return c.html(page.value, 409);
        }
        throw err;
      }
    }

    const scopes = scope.split(/\s+/).filter(Boolean);
    const body = renderConsentPage({
      clientName: consentResult.client.name ?? consentResult.client.id,
      scopes,
      action: `/api/oauth/consent${url.search}`,
      branding: consentResult.branding,
      csrfToken: consentResult.csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      // Re-render the consent page instead of returning JSON — the user
      // submitted a form (browser context), not an API call.
      const clientId = url.searchParams.get("client_id");
      if (clientId) {
        const csrfResult = await loadClientContextOrRenderError(c, clientId);
        if (csrfResult instanceof Response) return csrfResult;
        const { client, branding, csrfToken } = csrfResult;
        const scope = url.searchParams.get("scope") ?? "openid";
        const scopes = scope.split(/\s+/).filter(Boolean);
        const body = renderConsentPage({
          clientName: client.name ?? client.id,
          scopes,
          action: `/api/oauth/consent${url.search}`,
          branding,
          csrfToken,
          error: "Votre session a expiré. Veuillez réessayer.",
        });
        return c.html(body.value, 403);
      }
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
          const ctxOrRes = await loadClientContextOrRenderError(c, clientIdParam);
          if (ctxOrRes instanceof Response) return ctxOrRes;
          const ctx = ctxOrRes;
          const page = renderLoginPage({
            queryString: `?${oauthQuery}`,
            branding: ctx.branding,
            csrfToken: ctx.csrfToken,
            socialProviders: getSocialProviders(),
            smtpEnabled: isSmtpEnabled(),
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

    // Validate redirect URI against the client's registered post-logout URIs
    // to prevent open redirect attacks (OWASP). Fall back to "/" if no URI,
    // no client, or the URI is not registered.
    if (postLogoutUri && clientId) {
      const client = await getClient(clientId);
      if (client) {
        const postLogoutUris = client.postLogoutRedirectUris ?? [];
        if (postLogoutUris.includes(postLogoutUri)) {
          return c.redirect(postLogoutUri, 302);
        }
        // Fallback: also accept URIs registered as OAuth redirect URIs.
        // Some deployments re-use the same URI for both authorize callbacks
        // and post-logout redirects.
        const redirectUris = client.redirectUris ?? [];
        if (redirectUris.includes(postLogoutUri)) {
          return c.redirect(postLogoutUri, 302);
        }
        logger.warn("oidc: post_logout_redirect_uri not registered on client", {
          module: "oidc",
          clientId,
          postLogoutUri,
        });
      }
    } else if (postLogoutUri) {
      logger.warn("oidc: post_logout_redirect_uri without client_id — cannot validate, ignoring", {
        module: "oidc",
        postLogoutUri,
      });
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
