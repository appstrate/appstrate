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
import { db } from "@appstrate/db/client";
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
import { issueCsrfToken, verifyCsrfToken } from "./services/csrf.ts";
import { getOidcAuthApi } from "./auth/plugins.ts";
import { getAuth } from "@appstrate/db/auth";
import { UnverifiedEmailConflictError } from "./services/enduser-mapping.ts";
import { renderLoginPage } from "./pages/login.ts";
import { renderConsentPage } from "./pages/consent.ts";

export const createOAuthClientSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  redirectUris: z.array(z.url("redirectUris must be valid URLs")).min(1),
  scopes: z.array(z.string().min(1)).optional(),
});

export const updateOAuthClientSchema = z.object({
  redirectUris: z.array(z.url()).min(1).optional(),
  disabled: z.boolean().optional(),
});

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
    const auth = getAuth() as unknown as {
      api: { getOpenIdConfig: (args: { headers: Headers }) => Promise<unknown> };
    };
    const payload = await auth.api.getOpenIdConfig({ headers: c.req.raw.headers });
    c.header("cache-control", "public, max-age=3600");
    return c.json(payload as never);
  };

  const proxyOauthServerMetadata = async (c: Context<AppEnv>) => {
    const auth = getAuth() as unknown as {
      api: { getOAuthServerConfig: (args: { headers: Headers }) => Promise<unknown> };
    };
    const payload = await auth.api.getOAuthServerConfig({ headers: c.req.raw.headers });
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

    const [row] = await db
      .select({
        id: oauthClient.clientId,
        disabled: oauthClient.disabled,
        referenceId: oauthClient.referenceId,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    if (!row || row.disabled) throw notFound("Unknown OAuth client");

    const branding = row.referenceId ? await resolveAppBranding(row.referenceId) : undefined;
    const csrfToken = issueCsrfToken(c);
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
    const csrfOk = verifyCsrfToken(c, readFormString(form, "_csrf"));
    if (!csrfOk) {
      throw forbidden("CSRF token missing or invalid — reload the login page and try again");
    }

    const email = readFormString(form, "email")?.toLowerCase().trim();
    const password = readFormString(form, "password");
    if (!email || !password) {
      const [row] = await db
        .select({ referenceId: oauthClient.referenceId, disabled: oauthClient.disabled })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId))
        .limit(1);
      if (!row || row.disabled) throw notFound("Unknown OAuth client");
      const branding = row.referenceId ? await resolveAppBranding(row.referenceId) : undefined;
      const csrfToken = issueCsrfToken(c);
      const page = renderLoginPage({
        queryString: url.search,
        branding,
        csrfToken,
        error: "Email et mot de passe requis.",
        email: email ?? undefined,
      });
      return c.html(page.value, 400);
    }

    try {
      // signInEmail sets the session cookie on the response. We `asResponse:
      // true` so we can forward the Set-Cookie header, then issue our own
      // 302 back into the authorize endpoint with the original signed query.
      const authApi = getOidcAuthApi();
      const authResponse = (await authApi.signInEmail({
        body: { email, password },
        headers: c.req.raw.headers,
        asResponse: true,
      })) as Response;

      if (!authResponse.ok) {
        const [row] = await db
          .select({ referenceId: oauthClient.referenceId })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, clientId))
          .limit(1);
        const branding = row?.referenceId ? await resolveAppBranding(row.referenceId) : undefined;
        const csrfToken = issueCsrfToken(c);
        const page = renderLoginPage({
          queryString: url.search,
          branding,
          csrfToken,
          error: "Email ou mot de passe incorrect.",
          email,
        });
        return c.html(page.value, 401);
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
    } catch (err) {
      if (err instanceof UnverifiedEmailConflictError) {
        const [row] = await db
          .select({ referenceId: oauthClient.referenceId })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, clientId))
          .limit(1);
        const branding = row?.referenceId ? await resolveAppBranding(row.referenceId) : undefined;
        const csrfToken = issueCsrfToken(c);
        const page = renderLoginPage({
          queryString: url.search,
          branding,
          csrfToken,
          error:
            "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
          email,
        });
        return c.html(page.value, 409);
      }
      throw err;
    }
  });

  // GET /api/oauth/enduser/consent — server-rendered consent form.
  router.get("/oauth/enduser/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get("client_id");
    const scope = url.searchParams.get("scope") ?? "openid";
    if (!clientId) throw invalidRequest("client_id is required", "client_id");

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

    const scopes = scope.split(/\s+/).filter(Boolean);
    const branding = row.referenceId ? await resolveAppBranding(row.referenceId) : undefined;
    const csrfToken = issueCsrfToken(c);
    const body = renderConsentPage({
      clientName: row.name ?? row.id,
      scopes,
      action: `/api/oauth/enduser/consent${url.search}`,
      branding,
      csrfToken,
    });
    return c.html(body.value);
  });

  // POST /api/oauth/enduser/consent — verify CSRF then forward to Better
  // Auth's `/oauth2/consent` endpoint with the plugin's consent_code so the
  // authorization code is issued and the flow returns to the satellite's
  // redirect_uri. Session cookie (from the login step) carries the user.
  router.post("/oauth/enduser/consent", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);

    const form = await c.req.parseBody();
    const csrfOk = verifyCsrfToken(c, readFormString(form, "_csrf"));
    if (!csrfOk) {
      throw forbidden("CSRF token missing or invalid — reload the consent page and try again");
    }

    const accept = readFormString(form, "accept") === "true";
    const consentCode =
      url.searchParams.get("consent_code") ?? url.searchParams.get("code") ?? undefined;

    const authApi = getOidcAuthApi();
    const consentResponse = (await authApi.oauth2Consent({
      body: {
        accept,
        ...(consentCode ? { consent_code: consentCode } : {}),
      },
      headers: c.req.raw.headers,
      asResponse: true,
    })) as Response;

    // Forward the plugin's response verbatim (typically a 302 redirect to
    // the client's redirect_uri with `?code=...` or `?error=...`).
    return consentResponse;
  });

  return router;
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
