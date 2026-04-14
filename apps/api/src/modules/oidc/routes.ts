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
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit, rateLimitByIp } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { parseBody, notFound, invalidRequest, forbidden } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { getClientIp } from "../../lib/client-ip.ts";
import { db } from "@appstrate/db/client";
import { user, applications } from "@appstrate/db/schema";
import {
  createClient,
  deleteClient,
  getClient,
  getClientCached,
  getClientOwningOrg,
  listClientsForOrgAndApps,
  rotateClientSecret,
  updateClient,
  OAuthAdminValidationError,
  SIGNUP_ROLE_ALLOWED,
  type OAuthClientRecord,
} from "./services/oauth-admin.ts";
import {
  OrgSignupClosedError,
  resolveOrCreateOrgMembership,
} from "./services/orgmember-mapping.ts";
import {
  issuePendingClientCookie,
  clearPendingClientCookie,
} from "./services/pending-client-cookie.ts";
import { isValidRedirectUri } from "./services/redirect-uri.ts";
import { resolveBrandingForClient, PLATFORM_DEFAULT_BRANDING } from "./services/branding.ts";
import { issueCsrfToken, verifyCsrfToken } from "./services/csrf.ts";
import {
  getSmtpConfig,
  upsertSmtpConfig,
  deleteSmtpConfig,
  sendTestEmail,
} from "./services/smtp-admin.ts";
import { resolveSmtpForClient, type ResolvedSmtpConfig } from "./services/smtp-config.ts";
import {
  getSocialProvider,
  upsertSocialProvider,
  deleteSocialProvider,
} from "./services/social-admin.ts";
import { resolveSocialProviderForClient, type SocialProviderId } from "./services/social-config.ts";
import { isBlockedHost } from "@appstrate/core/ssrf";
import { getOidcAuthApi } from "./auth/api.ts";
import { withSmtpOverride } from "@appstrate/db/auth";
import { APPSTRATE_SCOPES } from "./auth/scopes.ts";
import { consumeLoginEmailAttempt, resetLoginEmailAttempts } from "./auth/guards.ts";
import {
  UnverifiedEmailConflictError,
  AppSignupClosedError,
  resolveOrCreateEndUser,
  loadAppById,
} from "./services/enduser-mapping.ts";
import { getEnv } from "@appstrate/env";
import { renderLoginPage } from "./pages/login.ts";
import { renderRegisterPage } from "./pages/register.ts";
import { renderMagicLinkPage } from "./pages/magic-link.ts";
import { renderMagicLinkConfirmPage } from "./pages/magic-link-confirm.ts";
import { renderVerifyEmailSentPage } from "./pages/verify-email-sent.ts";
import { renderForgotPasswordPage } from "./pages/forgot-password.ts";
import { renderResetPasswordPage, renderInvalidTokenPage } from "./pages/reset-password.ts";
import { renderConsentPage } from "./pages/consent.ts";
import { renderErrorPage } from "./pages/error.ts";
import { SOCIAL_SIGN_IN_SCRIPT } from "./pages/social-sign-in-script.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decide whether a Better Auth-signed `exp` query param (Unix seconds) marks
 * the login URL as expired.
 *
 * Defensive behavior:
 *  - Missing param → not expired (no constraint to enforce).
 *  - Non-numeric / NaN → treat as expired. `Number("garbage") < now` is
 *    `false` (NaN comparisons always are), which would silently let a
 *    tampered value bypass the check. Refuse explicitly instead.
 *  - Finite number in the past → expired.
 */
export function isLoginLinkExpired(expParam: string | null): boolean {
  if (!expParam) return false;
  const exp = Number(expParam);
  if (!Number.isFinite(exp)) return true;
  return exp < Date.now() / 1000;
}

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
  allowSignup: z.boolean().optional(),
  signupRole: z.enum(SIGNUP_ROLE_ALLOWED).optional(),
});

const createApplicationClientSchema = z.object({
  level: z.literal("application"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(redirectUriSchema).min(1),
  postLogoutRedirectUris: z.array(redirectUriSchema).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  referencedApplicationId: z.string().min(1),
  isFirstParty: z.boolean().optional(),
  // Unified signup opt-in. Secure-by-default → when omitted, the service
  // stores `false` and fresh end-user sign-ins are rejected until the
  // admin pre-creates them via the headless API.
  allowSignup: z.boolean().optional(),
  // Passed through to the service so we can reject it with a clear 400
  // (signupRole is only meaningful on org-level clients).
  signupRole: z.enum(SIGNUP_ROLE_ALLOWED).optional(),
});

export const createOAuthClientSchema = z.discriminatedUnion("level", [
  createOrgClientSchema,
  createApplicationClientSchema,
]);

export const smtpConfigUpsertSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(320),
  pass: z.string().min(1).max(1024),
  fromAddress: z.email(),
  // Reject CRLF/quotes to prevent email header injection — value is
  // concatenated into `"${fromName}" <${fromAddress}>` at send time.
  fromName: z
    .string()
    .max(200)
    .regex(/^[^"\r\n]*$/, "fromName must not contain quotes or line breaks")
    .optional(),
  secureMode: z.enum(["auto", "tls", "starttls", "none"]).optional(),
});

export const smtpConfigTestSchema = z.object({
  to: z.email(),
});

export const socialProviderIdSchema = z.enum(["google", "github"]);

export const socialProviderUpsertSchema = z.object({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
  scopes: z.array(z.string().min(1).max(128)).max(32).optional(),
});

export const updateOAuthClientSchema = z.object({
  redirectUris: z.array(redirectUriSchema).min(1).optional(),
  postLogoutRedirectUris: z.array(redirectUriSchema).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  disabled: z.boolean().optional(),
  isFirstParty: z.boolean().optional(),
  allowSignup: z.boolean().optional(),
  signupRole: z.enum(SIGNUP_ROLE_ALLOWED).optional(),
});

// ─── Shared page context loader ───────────────────────────────────────────────

interface PageContext {
  client: OAuthClientRecord;
  branding: Awaited<ReturnType<typeof resolveBrandingForClient>>;
  csrfToken: string;
  features: { smtp: boolean; socialGoogle: boolean; socialGithub: boolean };
  smtp: ResolvedSmtpConfig | null;
  /**
   * Per-client social-provider availability, passed verbatim to
   * `renderSocialButtons` on every OIDC page. For `level=application`
   * clients, reflects `application_social_providers` rows — buttons appear
   * only when the tenant has configured creds for that provider. For
   * `level=org` / `level=instance`, falls back to env presence (legacy
   * shared-OAuth-App behavior for non-app clients).
   */
  socialProviders: { google: boolean; github: boolean };
}

/**
 * Shared entrypoint for every public `/api/oauth/*` page handler.
 *
 * Runs the boilerplate every handler repeats:
 *  1. (optional) SMTP gate — renders a 404 error page when SMTP features
 *     are required but not configured.
 *  2. `client_id` extraction — renders a 400 error page when missing.
 *  3. Client load via the short-TTL cache from `oauth-admin.ts` (so the
 *     GET → POST round-trip reuses a single DB read) — renders a 404
 *     error page when the client is unknown / disabled.
 *  4. Branding + CSRF token resolution.
 *
 * Returns `{ url, ctx }` on success so handlers can chain directly, or a
 * ready-to-return `Response` on any failure above.
 */
async function loadPageContext(
  c: Context<AppEnv>,
  opts: {
    missingClientId: { title: string; message: string };
    requireSmtp?: { title: string; message: string };
  },
): Promise<{ url: URL; ctx: PageContext } | Response> {
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get("client_id");
  if (!clientId) {
    // requireSmtp gate is evaluated *after* client resolution below. Missing
    // client_id is a separate, earlier failure — rendering it first keeps the
    // error reason honest (no "SMTP disabled" banner when the caller has not
    // even identified a client).
    return c.html(renderErrorPage(opts.missingClientId).value, 400);
  }
  const record = await getClientCached(clientId);
  if (!record || record.disabled) {
    return c.html(
      renderErrorPage({
        title: "Application introuvable",
        message:
          "L'application associée à ce lien n'existe plus ou a été désactivée. Contactez l'administrateur de l'application.",
      }).value,
      404,
    );
  }
  // Resolve SMTP per-client: `level=application` reads `application_smtp_configs`,
  // `level=org`/`level=instance` falls back to env SMTP. Null → email features
  // disabled for this flow (no instance fallback for app-level clients).
  const smtp = await resolveSmtpForClient(record);
  if (opts.requireSmtp && !smtp) {
    return c.html(renderErrorPage(opts.requireSmtp).value, 404);
  }
  // Per-client social provider availability. Application-level clients read
  // from `application_social_providers` (tenant-owned OAuth App). Org and
  // instance clients keep the legacy env-based fallback — the platform's
  // shared Google/GitHub OAuth App is the appropriate identity issuer for
  // dashboard / satellite flows.
  let socialGoogle: boolean;
  let socialGithub: boolean;
  if (record.level === "application") {
    const [g, gh] = await Promise.all([
      resolveSocialProviderForClient(record, "google"),
      resolveSocialProviderForClient(record, "github"),
    ]);
    socialGoogle = !!g;
    socialGithub = !!gh;
  } else {
    const env = getEnv();
    socialGoogle = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    socialGithub = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  }
  return {
    url,
    ctx: {
      client: record,
      branding: await resolveBrandingForClient(record),
      csrfToken: issueCsrfToken(c),
      features: { smtp: !!smtp, socialGoogle, socialGithub },
      smtp,
      socialProviders: { google: socialGoogle, github: socialGithub },
    },
  };
}

/**
 * Forward Better Auth session `set-cookie` headers to the browser, capping
 * `Max-Age` to 5 minutes for third-party clients so the intermediate BA
 * session lasts exactly long enough for the OAuth redirect chain. First-party
 * clients keep the default TTL because their BA session IS the primary auth.
 *
 * Uses `c.header("set-cookie", …, { append: true })` (not `new Response`)
 * so the forwarded cookies survive alongside the CSRF cookie deletion that
 * `verifyCsrfToken` already queued on the context.
 */
const OAUTH_SESSION_MAX_AGE_SECONDS = 300;
function forwardOAuthSessionCookies(
  c: Context<AppEnv>,
  authResponse: Response,
  isFirstParty: boolean,
): number {
  const getSetCookie = (authResponse.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  const setCookies =
    typeof getSetCookie === "function" ? getSetCookie.call(authResponse.headers) : [];
  for (const raw of setCookies) {
    if (isFirstParty) {
      c.header("set-cookie", raw, { append: true });
    } else {
      const patched = raw.includes("Max-Age=")
        ? raw.replace(/Max-Age=\d+/gi, `Max-Age=${OAUTH_SESSION_MAX_AGE_SECONDS}`)
        : `${raw}; Max-Age=${OAUTH_SESSION_MAX_AGE_SECONDS}`;
      c.header("set-cookie", patched, { append: true });
    }
  }
  return setCookies.length;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Instance-level SMTP presence. Kept for the signup handler's cookieCount
 * interstitial branch, which runs before any per-client SMTP resolution and
 * only cares whether Better Auth sent a verification email via env SMTP.
 * All other OIDC flows read `ctx.features.smtp` from `PageContext`.
 */
function isInstanceSmtpEnabled(): boolean {
  const env = getEnv();
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

/**
 * Effective "is signup open" flag for a client's entry pages. Unified
 * across all levels (instance / org / application) per `a2aae3af` — aligns
 * with FusionAuth (per-application `registrationConfiguration.enabled`),
 * Auth0 (per-connection `disable_signups`), and Okta (policy-bound SSR):
 * when signup is closed the hosted login UI hides the CTA rather than
 * showing it and rejecting at submit.
 *
 * Instance clients declared via `OIDC_INSTANCE_CLIENTS` default to
 * `allowSignup: false` (satellites like an admin portal provision members
 * out-of-band). `ensureInstanceClient()` opts the fresh-install first-party
 * client in at boot.
 */
function allowSignupForClient(client: { allowSignup: boolean }): boolean {
  return client.allowSignup;
}

/**
 * Map an `?error=<code>` from the Better Auth social callback redirect (or
 * from our own error-callback URL) to a user-facing French banner on the
 * login page. Codes we don't recognize fall back to a generic message so the
 * user isn't left with a silent white screen.
 */
function mapLoginErrorCode(code: string): string {
  switch (code) {
    case "signup_disabled":
      return "L'inscription n'est pas ouverte sur cette application. Contactez un administrateur pour être ajouté à l'organisation.";
    case "new_user_signup_disabled":
      return "Aucun compte n'existe pour cette adresse email. Créez un compte ou utilisez un autre fournisseur de connexion.";
    case "email_not_found":
      return "Le fournisseur n'a pas retourné d'adresse email. Veuillez réessayer avec un autre compte.";
    case "account_already_linked_to_different_user":
      return "Ce compte est déjà lié à un autre utilisateur.";
    case "unable_to_link_account":
      return "Impossible de lier ce compte. Veuillez réessayer.";
    case "email_doesn't_match":
      return "L'email ne correspond pas au compte existant.";
    case "unable_to_create_user":
    case "unable_to_create_session":
      return "Impossible de créer le compte. Veuillez réessayer.";
    default:
      return "La connexion a échoué. Veuillez réessayer.";
  }
}

/**
 * Remove `error=<code>` from a query string so social-sign-in buttons and
 * the register-CTA link don't carry the stale error parameter forward. We
 * keep everything else (client_id, redirect_uri, scope, state, …) intact
 * **byte-for-byte** — do NOT round-trip through `URLSearchParams`, which
 * would re-encode `%20` as `+` and break clients that compare the echoed
 * query string to the one they originally sent.
 */
function stripErrorFromQueryString(search: string): string {
  if (!search) return search;
  const body = search.startsWith("?") ? search.slice(1) : search;
  const kept = body.split("&").filter((pair) => pair !== "" && !pair.startsWith("error="));
  return kept.length ? `?${kept.join("&")}` : "";
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

  // ── Admin: per-application SMTP configuration ─────────────────────────────
  //
  // Scoped to applications owned by the caller's org. Per-app SMTP replaces
  // instance-level env SMTP for `level=application` OIDC flows — without a
  // row, verification emails, magic-link, and reset-password are disabled for
  // that app's clients. See `services/smtp-config.ts` for the resolver.

  const assertAppBelongsToOrg = async (c: Context<AppEnv>, applicationId: string) => {
    const orgId = c.get("orgId");
    const [app] = await db
      .select({ orgId: applications.orgId })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!app || app.orgId !== orgId) throw notFound("Application not found");
  };

  router.get(
    "/api/applications/:id/smtp-config",
    rateLimit(300),
    requirePermission("applications", "read"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const config = await getSmtpConfig(applicationId);
      if (!config) throw notFound("SMTP configuration not found");
      return c.json(config);
    },
  );

  router.put(
    "/api/applications/:id/smtp-config",
    rateLimit(20),
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const body = await c.req.json();
      const data = parseBody(smtpConfigUpsertSchema, body);
      // SSRF: block configurations that would make Appstrate bounce
      // email traffic off internal metadata endpoints / loopback relays.
      if (isBlockedHost(data.host)) {
        throw invalidRequest("host resolves to a private/internal network", "host");
      }
      const saved = await upsertSmtpConfig(applicationId, data);
      return c.json(saved);
    },
  );

  router.delete(
    "/api/applications/:id/smtp-config",
    rateLimit(10),
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const deleted = await deleteSmtpConfig(applicationId);
      if (!deleted) throw notFound("SMTP configuration not found");
      return c.body(null, 204);
    },
  );

  router.post(
    "/api/applications/:id/smtp-config/test",
    rateLimit(5),
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const body = await c.req.json();
      const data = parseBody(smtpConfigTestSchema, body);
      try {
        const result = await sendTestEmail(applicationId, data.to);
        return c.json({ ok: true, messageId: result.messageId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surface the SMTP server's response verbatim — DKIM/SPF/auth
        // misconfigurations are the admin's to fix, so we must not swallow
        // the underlying error.
        if (message.includes("SMTP configuration not found")) {
          throw notFound(message);
        }
        return c.json({ ok: false, error: message }, 400);
      }
    },
  );

  // ── Admin: per-application social auth providers ──────────────────────────
  //
  // Scoped to applications owned by the caller's org. Per-app social auth
  // replaces the instance env `GOOGLE_CLIENT_*` / `GITHUB_CLIENT_*` pair for
  // `level=application` OIDC flows — without a row for a given provider, that
  // provider's button is hidden on the tenant's login/register pages (no
  // fallback to env creds, same rule as SMTP). See `services/social-config.ts`
  // for the resolver.

  const parseProvider = (raw: string): SocialProviderId => {
    const result = socialProviderIdSchema.safeParse(raw);
    if (!result.success) throw notFound("Unknown social provider");
    return result.data;
  };

  router.get(
    "/api/applications/:id/social-providers/:provider",
    rateLimit(300),
    requirePermission("applications", "read"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const provider = parseProvider(c.req.param("provider")!);
      const config = await getSocialProvider(applicationId, provider);
      if (!config) throw notFound("Social provider configuration not found");
      return c.json(config);
    },
  );

  router.put(
    "/api/applications/:id/social-providers/:provider",
    rateLimit(20),
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const provider = parseProvider(c.req.param("provider")!);
      const body = await c.req.json();
      const data = parseBody(socialProviderUpsertSchema, body);
      const saved = await upsertSocialProvider(applicationId, provider, data);
      return c.json(saved);
    },
  );

  router.delete(
    "/api/applications/:id/social-providers/:provider",
    rateLimit(10),
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("id")!;
      await assertAppBelongsToOrg(c, applicationId);
      const provider = parseProvider(c.req.param("provider")!);
      const deleted = await deleteSocialProvider(applicationId, provider);
      if (!deleted) throw notFound("Social provider configuration not found");
      return c.body(null, 204);
    },
  );

  // ── Public static assets ──────────────────────────────────────────────────
  //
  // Served as external JS (not inline) so login/register pages stay
  // compatible with a strict `script-src 'self'` CSP without needing
  // per-request nonces. The source lives in `pages/social-sign-in-script.ts`
  // as a module-level constant — zero build step, safe to cache for a long
  // time because the string only changes on deploy.
  router.get("/api/oauth/assets/social-sign-in.js", rateLimitByIp(120), () => {
    return new Response(SOCIAL_SIGN_IN_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // ── Public polymorphic login/consent pages ─────────────────────────────────

  router.get("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, {
      missingClientId: {
        title: "Lien de connexion invalide",
        message:
          "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
      },
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    // Better Auth signs the redirect with `exp` (Unix seconds). Reject
    // expired login URLs so stale links cannot create upstream sessions.
    if (isLoginLinkExpired(url.searchParams.get("exp"))) {
      const body = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: "",
        socialProviders: ctx.socialProviders,
        smtpEnabled: ctx.features.smtp,
        allowSignup: allowSignupForClient(ctx.client),
        error:
          "Ce lien de connexion a expiré. Veuillez relancer la connexion depuis l'application.",
      });
      return c.html(body.value, 400);
    }
    // Pin the pending client_id in a signed cookie so the BA `beforeSignup`
    // hook can enforce the signup policy on social / magic-link flows that
    // bypass our own POST handlers. See `services/pending-client-cookie.ts`.
    issuePendingClientCookie(c, ctx.client.clientId);
    // Better Auth appends `?error=<code>` to `errorCallbackURL` when the
    // social callback fails — including when our `beforeSignup` guard throws
    // `signup_disabled` for a closed org-level client. Surface a friendly
    // banner instead of silently rendering a blank login page.
    const errorCode = url.searchParams.get("error");
    const errorMessage = errorCode ? mapLoginErrorCode(errorCode) : undefined;
    const body = renderLoginPage({
      queryString: stripErrorFromQueryString(url.search),
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
      socialProviders: ctx.socialProviders,
      smtpEnabled: ctx.features.smtp,
      allowSignup: allowSignupForClient(ctx.client),
      error: errorMessage,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/login", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, {
      missingClientId: {
        title: "Lien de connexion invalide",
        message:
          "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
      },
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    const allowSignup = allowSignupForClient(ctx.client);
    // Reject form submissions for expired login URLs — prevents creating a
    // Better Auth session from a stale link. Render the login page with an
    // inline error (same as the GET handler) instead of returning JSON —
    // the browser submitted a form, not an API call.
    if (isLoginLinkExpired(url.searchParams.get("exp"))) {
      const body = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: "",
        socialProviders: ctx.socialProviders,
        smtpEnabled: ctx.features.smtp,
        allowSignup,
        error:
          "Ce lien de connexion a expiré. Veuillez relancer la connexion depuis l'application.",
      });
      return c.html(body.value, 400);
    }

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      const page = renderLoginPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: ctx.socialProviders,
        smtpEnabled: ctx.features.smtp,
        allowSignup,
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(page.value, 403);
    }
    const socialProviders = ctx.socialProviders;
    const smtpEnabled = ctx.features.smtp;
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
        allowSignup,
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
    // Same reasoning as the register handler: pin the verification email
    // callbackURL so a failed login on an unverified account produces a
    // resend-link that resumes the OAuth flow on click.
    const verificationCallbackURL = `/api/auth/oauth2/authorize${url.search}`;
    let authResponse: Response;
    try {
      authResponse = (await authApi.signInEmail({
        // `callbackURL` is accepted by BA's sign-in endpoint (it becomes the
        // email-verification resend target) but is missing from the exported
        // input type — cast narrowly to keep the rest of the body strict.
        body: { email, password, callbackURL: verificationCallbackURL } as {
          email: string;
          password: string;
        },
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
      // BA returns 403 with `{ code: "EMAIL_NOT_VERIFIED" }` for unverified
      // accounts. `sendOnSignIn` has already fired a fresh verification
      // email with the pinned `callbackURL` above, so render the same
      // branded interstitial as post-signup — clicking the link resumes
      // the OAuth flow.
      if (authResponse.status === 403 && bodyText.includes("EMAIL_NOT_VERIFIED")) {
        clearPendingClientCookie(c);
        const sentPage = renderVerifyEmailSentPage({
          queryString: url.search,
          branding: ctx.branding,
          email,
        });
        return c.html(sentPage.value);
      }
      return renderError("Email ou mot de passe incorrect.", 401, email);
    }

    await resetLoginEmailAttempts(email);

    // For org-level clients: proactively resolve-or-create the membership
    // so the failure surfaces as a clear 403 here instead of an opaque
    // `access_denied` three redirects deep at token-mint time. Respects
    // the client's `allowSignup` policy — closed orgs reject non-members
    // with a styled error page, open orgs auto-provision with
    // `signupRole`. The mirror call in `buildOrgLevelClaims` is a no-op
    // for existing members (SELECT-only step 1).
    if (ctx.client.level === "org" && ctx.client.referencedOrgId) {
      const [authUserRow] = await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (authUserRow) {
        try {
          await resolveOrCreateOrgMembership(
            { id: authUserRow.id, email: authUserRow.email },
            ctx.client.referencedOrgId,
            {
              allowSignup: ctx.client.allowSignup,
              signupRole: ctx.client.signupRole,
            },
          );
        } catch (err) {
          if (err instanceof OrgSignupClosedError) {
            return renderError(
              "Ce compte n'est pas membre de l'organisation et l'inscription n'est pas ouverte sur cette application. Contactez votre administrateur.",
              403,
              email,
            );
          }
          throw err;
        }
      }
    }

    // For application-level clients: proactively resolve-or-create the
    // end-user row so `UnverifiedEmailConflictError` surfaces as a 409 here
    // rather than as an opaque 500 three redirects deep at token-mint time.
    // Org-level clients skip this — they don't create end_users rows.
    //
    // INTENTIONAL DOUBLE CALL: `resolveOrCreateEndUser` is also invoked
    // later during token minting in `auth/plugins.ts` (customAccessTokenClaims).
    // This is safe by design — the function is idempotent and race-safe:
    // step 1 is a SELECT-only `findLinkedEndUser` lookup that returns the
    // existing row without side effects, so the second call is a no-op for
    // the common case (the first call either found or created the link).
    // See `services/enduser-mapping.ts` for the full contract.
    //
    // WARNING: if future changes add observable side effects to
    // `resolveOrCreateEndUser` (events, webhooks, audit logs), they will
    // fire TWICE for application-level logins. Gate any such side effect
    // on a "newly created" flag returned from the function, or move the
    // proactive check to a side-effect-free probe.
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
              { allowSignup: ctx.client.allowSignup },
            );
          } catch (err) {
            if (err instanceof UnverifiedEmailConflictError) {
              return renderError(
                "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
                409,
                email,
              );
            }
            if (err instanceof AppSignupClosedError) {
              return renderError(
                "L'inscription automatique est désactivée pour cette application. Contactez votre administrateur pour qu'il crée votre compte avant votre connexion.",
                403,
                email,
              );
            }
            throw err;
          }
        }
      }
    }

    forwardOAuthSessionCookies(c, authResponse, ctx.client.isFirstParty);
    logger.info("oidc: login success", {
      firstParty: ctx.client.isFirstParty,
      email,
    });
    // Clear the pending-client cookie — the signup policy guard has done
    // its job (or was never needed for this login of an existing member).
    clearPendingClientCookie(c);
    return c.redirect(`/api/auth/oauth2/authorize${url.search}`, 302);
  });

  // ── Public registration page ──────────────────────────────────────────────

  router.get("/api/oauth/register", rateLimitByIp(30), async (c) => {
    const page = await loadPageContext(c, {
      missingClientId: {
        title: "Lien d'inscription invalide",
        message:
          "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
      },
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    // Closed signup → no register form at all (uniform across levels).
    if (!ctx.client.allowSignup) {
      return c.html(
        renderErrorPage({
          title: "Inscription fermée",
          message:
            "L'inscription n'est pas ouverte sur cette application. Contactez votre administrateur pour obtenir un accès.",
          branding: ctx.branding,
        }).value,
        403,
      );
    }
    // Same pending-client cookie as GET /api/oauth/login — covers the social
    // sign-in buttons surfaced on the register page.
    issuePendingClientCookie(c, ctx.client.clientId);
    const body = renderRegisterPage({
      queryString: url.search,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
      socialProviders: ctx.socialProviders,
      allowSignup: true,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/register", rateLimitByIp(20), async (c) => {
    const page = await loadPageContext(c, {
      missingClientId: {
        title: "Lien d'inscription invalide",
        message:
          "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
      },
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    // Defense in depth: the GET handler hides the form when signup is
    // closed, but a hand-crafted POST must still be rejected here. Returning
    // the styled error page (instead of `renderRegError` with a banner)
    // matches the GET behavior — there is no form to retry.
    if (!ctx.client.allowSignup) {
      return c.html(
        renderErrorPage({
          title: "Inscription fermée",
          message:
            "L'inscription n'est pas ouverte sur cette application. Contactez votre administrateur pour obtenir un accès.",
          branding: ctx.branding,
        }).value,
        403,
      );
    }

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      const page = renderRegisterPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: ctx.socialProviders,
        allowSignup: allowSignupForClient(ctx.client),
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(page.value, 403);
    }

    const renderRegError = (
      error: string,
      status: 400 | 403 | 409 | 429 | 500,
      email?: string,
      name?: string,
    ) => {
      const page = renderRegisterPage({
        queryString: url.search,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        socialProviders: ctx.socialProviders,
        allowSignup: allowSignupForClient(ctx.client),
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
    // Pin the BA verification email's `callbackURL` to the authorize endpoint
    // with the original OAuth query string. After the user clicks the link,
    // BA sets the session cookie (via `autoSignInAfterVerification`) and
    // redirects there — resuming the OAuth flow transparently. Without this,
    // the link would land on `/` and the third-party client would never see
    // the completed sign-in.
    const verificationCallbackURL = `/api/auth/oauth2/authorize${url.search}`;
    let authResponse: Response;
    try {
      // Wrap the BA call in the per-client SMTP override so every OIDC flow
      // — application, org, instance — routes its outbound mail through the
      // same resolver-provided transport. `ctx.smtp` is the resolver's
      // answer (per-app row for app-level clients, env SMTP for org/instance,
      // null when nothing is configured) and supersedes the boot-time
      // transport captured in `@appstrate/db/auth`.
      authResponse = (await withSmtpOverride(ctx.smtp, () =>
        authApi.signUpEmail({
          body: { email, password, name, callbackURL: verificationCallbackURL } as {
            email: string;
            password: string;
            name: string;
          },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      )) as Response;
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

    let cookieCount = forwardOAuthSessionCookies(c, authResponse, ctx.client.isFirstParty);

    // Application-level clients without per-app SMTP → no way to deliver a
    // verification email for this tenant. Auto-verify the freshly-created
    // user and re-sign-in to get a session, so the subsequent /authorize
    // redirect mints a token transparently. Instance env SMTP is explicitly
    // NOT used as fallback — mixing tenant traffic through the platform's
    // transport is the exact branding/deliverability leak this architecture
    // is designed to prevent. Org-level and instance-level clients keep the
    // env-driven flow.
    if (
      ctx.client.level === "application" &&
      !ctx.features.smtp &&
      cookieCount === 0 &&
      isInstanceSmtpEnabled()
    ) {
      await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
      try {
        const reSignIn = (await authApi.signInEmail({
          body: { email, password } as { email: string; password: string },
          headers: c.req.raw.headers,
          asResponse: true,
        })) as Response;
        if (reSignIn.ok) {
          cookieCount = forwardOAuthSessionCookies(c, reSignIn, ctx.client.isFirstParty);
        }
      } catch (err) {
        logger.warn("oidc: auto-verify re-signin failed", {
          error: err instanceof Error ? err.message : String(err),
          email,
        });
      }
    }

    // Org-level clients: provision the `organization_members` row now so
    // the subsequent `authorize` redirect chain mints a token with the
    // configured `org_role`. The policy has already passed the GET guard
    // and the POST guard; `allowSignup` is guaranteed `true` here.
    if (ctx.client.level === "org" && ctx.client.referencedOrgId) {
      const [authUserRow] = await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (authUserRow) {
        try {
          await resolveOrCreateOrgMembership(
            { id: authUserRow.id, email: authUserRow.email },
            ctx.client.referencedOrgId,
            {
              allowSignup: ctx.client.allowSignup,
              signupRole: ctx.client.signupRole,
            },
          );
        } catch (err) {
          if (err instanceof OrgSignupClosedError) {
            // Should not happen — the GET + POST guards checked already.
            logger.warn("oidc: signup closed after signUpEmail succeeded", {
              userId: authUserRow.id,
              orgId: ctx.client.referencedOrgId,
            });
            return renderRegError(
              "L'inscription n'est pas ouverte sur cette application. Contactez votre administrateur.",
              403,
              email,
              name,
            );
          }
          throw err;
        }
      }
    }

    logger.info("oidc: registration success", { email });
    clearPendingClientCookie(c);
    // With SMTP enabled, BA's `requireEmailVerification: true` means
    // `signUpEmail` does NOT create a session — there are no cookies to
    // forward and the subsequent `/authorize` redirect would land on the
    // login page with no context. Render a branded "check your email"
    // interstitial that matches the client's logo/colors. The verification
    // link itself (in the email) will resume the OAuth flow via the
    // `callbackURL` we pinned to `signUpEmail` above.
    if (ctx.features.smtp && cookieCount === 0) {
      const sentPage = renderVerifyEmailSentPage({
        queryString: url.search,
        branding: ctx.branding,
        email,
      });
      return c.html(sentPage.value);
    }
    return c.redirect(`/api/auth/oauth2/authorize${url.search}`, 302);
  });

  // ── Public magic-link sign-in page ────────────────────────────────────────
  //
  // Mirrors the register flow: GET renders a one-field form, POST hands off
  // to Better Auth's `signInMagicLink` with a `callbackURL` pointing back at
  // the OAuth authorize endpoint so the verification link resumes the flow.
  //
  // Gate: SMTP must be configured. Without SMTP the magic-link plugin is not
  // loaded, so the endpoints are absent server-side — we return 404 from the
  // OIDC wrapper to keep the failure obvious rather than letting BA emit an
  // opaque 500 from an undefined endpoint.

  const MAGIC_LINK_SMTP_GATE = {
    title: "Connexion par lien magique indisponible",
    message: "Cette méthode de connexion n'est pas activée sur cette instance.",
  };
  const MAGIC_LINK_MISSING_CLIENT = {
    title: "Lien de connexion invalide",
    message:
      "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
  };

  router.get("/api/oauth/magic-link", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: MAGIC_LINK_SMTP_GATE,
      missingClientId: MAGIC_LINK_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    // The pending cookie pins the client_id so the BA `beforeSignup` guard
    // (`oidcBeforeSignupGuard`) applies the org-level signup policy at
    // verify time: creation is allowed for instance/app clients and for
    // org-level clients with `allowSignup: true`, and blocked otherwise.
    issuePendingClientCookie(c, ctx.client.clientId);
    const body = renderMagicLinkPage({
      queryString: url.search,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/magic-link", rateLimitByIp(20), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: MAGIC_LINK_SMTP_GATE,
      missingClientId: MAGIC_LINK_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    const form = await c.req.parseBody();
    const renderFormError = (error: string, status: 400 | 403) =>
      c.html(
        renderMagicLinkPage({
          queryString: url.search,
          branding: ctx.branding,
          csrfToken: ctx.csrfToken,
          error,
        }).value,
        status,
      );
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      return renderFormError("Votre session a expiré. Veuillez réessayer.", 403);
    }

    const email = readFormString(form, "email")?.toLowerCase().trim();
    if (!email) {
      return renderFormError("Email requis.", 400);
    }

    // The verification link, once clicked, creates a BA session and
    // redirects to `callbackURL` — pointing at the authorize endpoint
    // resumes the OAuth flow exactly like after a successful password
    // login. Preserving `queryString` keeps client_id / redirect_uri /
    // state / PKCE intact end-to-end.
    //
    // Absolute URLs are required: Better Auth's origin-check middleware
    // validates relative callbackURLs with a strict regex that forbids
    // spaces in the query string, and URLSearchParams decodes `+` in
    // `scope=openid+profile+email` (or `%2B` in the PKCE `sig`) as a
    // space — failing the regex. Absolute URLs go through the origin
    // comparison branch instead and bypass the regex entirely.
    const callbackURL = `${url.origin}/api/auth/oauth2/authorize${url.search}`;
    const errorCallbackURL = `${url.origin}/api/oauth/login${url.search}`;

    const authApi = getOidcAuthApi();
    try {
      await withSmtpOverride(ctx.smtp, () =>
        authApi.signInMagicLink({
          body: { email, callbackURL, errorCallbackURL },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      );
    } catch (err) {
      // Better Auth already swallows per-user failures internally (the
      // plugin's sendMagicLink handler is fire-and-forget). A throw here
      // is an infra error — log and render generic guidance. We still
      // show the "sent" screen to preserve anti-enumeration.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("oidc: signInMagicLink threw", { error: msg, email });
    }

    logger.info("oidc: magic link requested", { email });
    const sentPage = renderMagicLinkPage({
      queryString: url.search,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
      email,
      sent: true,
    });
    return c.html(sentPage.value);
  });

  // ── Magic-link confirmation interstitial ──────────────────────────────────
  //
  // Gates the one-shot BA `/api/auth/magic-link/verify` behind an explicit
  // click. The outgoing email (see `sendMagicLink` in packages/db/src/auth.ts)
  // is rewritten to point here instead of directly at BA's verify endpoint.
  //
  // GET renders a static "Confirm sign-in" page — safe to prefetch (no state
  // change). POST verifies the CSRF cookie and 302s the user's browser to
  // BA's verify URL, where the token is consumed and the session cookie is
  // set in the user's own browser (not the prefetcher's).
  //
  // Branding: client_id lives inside the URL-encoded `callbackURL` query
  // param — we parse it defensively and fall back to platform defaults on
  // any error. The confirm page is a short transitional surface; a missing
  // brand is acceptable (the user is about to land on the authorize /
  // application redirect anyway).

  async function resolveConfirmBranding(
    callbackURL: string | null,
  ): Promise<Awaited<ReturnType<typeof resolveBrandingForClient>>> {
    if (!callbackURL) return { ...PLATFORM_DEFAULT_BRANDING };
    try {
      const cb = new URL(callbackURL);
      const clientId = cb.searchParams.get("client_id");
      if (!clientId) return { ...PLATFORM_DEFAULT_BRANDING };
      const record = await getClientCached(clientId);
      if (!record) return { ...PLATFORM_DEFAULT_BRANDING };
      return await resolveBrandingForClient(record);
    } catch {
      return { ...PLATFORM_DEFAULT_BRANDING };
    }
  }

  function buildConfirmActionQuery(
    token: string,
    callbackURL: string | null,
    errorCallbackURL: string | null,
  ): string {
    const params = new URLSearchParams();
    params.set("token", token);
    if (callbackURL) params.set("callbackURL", callbackURL);
    if (errorCallbackURL) params.set("errorCallbackURL", errorCallbackURL);
    return `?${params.toString()}`;
  }

  router.get("/api/oauth/magic-link/confirm", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return c.html(
        renderErrorPage({
          title: "Lien de connexion invalide",
          message: "Ce lien de connexion n'est pas valide. Veuillez relancer la connexion.",
        }).value,
        400,
      );
    }
    const callbackURL = url.searchParams.get("callbackURL");
    const errorCallbackURL = url.searchParams.get("errorCallbackURL");
    const branding = await resolveConfirmBranding(callbackURL);
    const csrfToken = issueCsrfToken(c);
    const body = renderMagicLinkConfirmPage({
      action: `/api/oauth/magic-link/confirm${buildConfirmActionQuery(
        token,
        callbackURL,
        errorCallbackURL,
      )}`,
      csrfToken,
      branding,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/magic-link/confirm", rateLimitByIp(60), async (c) => {
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return c.html(
        renderErrorPage({
          title: "Lien de connexion invalide",
          message: "Ce lien de connexion n'est pas valide. Veuillez relancer la connexion.",
        }).value,
        400,
      );
    }
    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      const callbackURL = url.searchParams.get("callbackURL");
      const errorCallbackURL = url.searchParams.get("errorCallbackURL");
      const branding = await resolveConfirmBranding(callbackURL);
      const csrfToken = issueCsrfToken(c);
      const retry = renderMagicLinkConfirmPage({
        action: `/api/oauth/magic-link/confirm${buildConfirmActionQuery(
          token,
          callbackURL,
          errorCallbackURL,
        )}`,
        csrfToken,
        branding,
      });
      return c.html(retry.value, 403);
    }

    // Hand off to Better Auth's verify endpoint in the USER's browser — BA
    // consumes the single-use token, sets the session cookie on their origin,
    // and 302s to callbackURL (the authorize endpoint).
    const verifyUrl = new URL("/api/auth/magic-link/verify", url.origin);
    verifyUrl.searchParams.set("token", token);
    const callbackURL = url.searchParams.get("callbackURL");
    const errorCallbackURL = url.searchParams.get("errorCallbackURL");
    if (callbackURL) verifyUrl.searchParams.set("callbackURL", callbackURL);
    if (errorCallbackURL) verifyUrl.searchParams.set("errorCallbackURL", errorCallbackURL);
    return c.redirect(verifyUrl.toString(), 302);
  });

  // ── Public forgot-password page ───────────────────────────────────────────
  //
  // Better Auth's `requestPasswordReset` endpoint has anti-enumeration built
  // in — it returns `{ status: true, message: ... }` regardless of whether
  // the email exists. We piggy-back on that and always render the "sent"
  // confirmation screen after a successful POST.
  //
  // `redirectTo` points at our own reset page; Better Auth will URL-encode
  // it into the verification link and BA's GET /reset-password/:token
  // handler validates the token, then 302s to
  // `/api/oauth/reset-password?{queryString}&token={token}`.

  const FORGOT_PASSWORD_SMTP_GATE = {
    title: "Réinitialisation du mot de passe indisponible",
    message:
      "La réinitialisation par email n'est pas activée sur cette instance. Contactez l'administrateur.",
  };
  const FORGOT_PASSWORD_MISSING_CLIENT = {
    title: "Lien invalide",
    message: "L'identifiant de l'application est manquant.",
  };

  router.get("/api/oauth/forgot-password", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: FORGOT_PASSWORD_SMTP_GATE,
      missingClientId: FORGOT_PASSWORD_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    const body = renderForgotPasswordPage({
      queryString: url.search,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/forgot-password", rateLimitByIp(20), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: FORGOT_PASSWORD_SMTP_GATE,
      missingClientId: FORGOT_PASSWORD_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    const form = await c.req.parseBody();
    const renderFormError = (error: string, status: 400 | 403) =>
      c.html(
        renderForgotPasswordPage({
          queryString: url.search,
          branding: ctx.branding,
          csrfToken: ctx.csrfToken,
          error,
        }).value,
        status,
      );
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      return renderFormError("Votre session a expiré. Veuillez réessayer.", 403);
    }

    const email = readFormString(form, "email")?.toLowerCase().trim();
    if (!email) {
      return renderFormError("Email requis.", 400);
    }

    // Absolute URL so Better Auth's origin-check accepts it — see the
    // magic-link route above for the full rationale (BA's relative-path
    // regex rejects spaces in the query string).
    const redirectTo = `${url.origin}/api/oauth/reset-password${url.search}`;

    const authApi = getOidcAuthApi();
    try {
      await withSmtpOverride(ctx.smtp, () =>
        authApi.requestPasswordReset({
          body: { email, redirectTo },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("oidc: requestPasswordReset threw", { error: msg, email });
      // Still render "sent" to preserve anti-enumeration.
    }

    logger.info("oidc: password reset requested", { email });
    const sentPage = renderForgotPasswordPage({
      queryString: url.search,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
      email,
      sent: true,
    });
    return c.html(sentPage.value);
  });

  // ── Public reset-password page (second leg of the reset flow) ──────────────
  //
  // Entry point from the email verification redirect:
  //   `/api/oauth/reset-password?{queryString}&token={token}`
  //
  // If the token is missing or the Better Auth callback rejected it
  // (`?error=INVALID_TOKEN`), render the dedicated invalid-token screen with
  // a link to request a fresh email.
  //
  // On POST, call Better Auth's `resetPassword` with the hidden token field.
  // Success does NOT create a session — the page renders a confirmation that
  // bounces back to /api/oauth/login${queryString} so the user signs in with
  // the new password and resumes the OAuth flow.

  const RESET_PASSWORD_SMTP_GATE = {
    title: "Réinitialisation du mot de passe indisponible",
    message: "La réinitialisation par email n'est pas activée sur cette instance.",
  };
  const RESET_PASSWORD_MISSING_CLIENT = {
    title: "Lien invalide",
    message: "L'identifiant de l'application est manquant.",
  };

  router.get("/api/oauth/reset-password", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: RESET_PASSWORD_SMTP_GATE,
      missingClientId: RESET_PASSWORD_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    // Strip our own locally-owned params from the forwarded queryString so
    // that links back to login/forgot-password don't carry stale tokens.
    const forwardQuery = stripResetParams(url.searchParams);

    const token = url.searchParams.get("token");
    const error = url.searchParams.get("error");
    if (!token || error) {
      return c.html(
        renderInvalidTokenPage({ queryString: forwardQuery, branding: ctx.branding }).value,
        400,
      );
    }
    const body = renderResetPasswordPage({
      queryString: forwardQuery,
      token,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/reset-password", rateLimitByIp(20), async (c) => {
    const page = await loadPageContext(c, {
      requireSmtp: RESET_PASSWORD_SMTP_GATE,
      missingClientId: RESET_PASSWORD_MISSING_CLIENT,
    });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    const forwardQuery = stripResetParams(url.searchParams);

    const form = await c.req.parseBody();
    const token = readFormString(form, "token")?.trim() ?? "";

    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      if (!token) {
        return c.html(
          renderInvalidTokenPage({ queryString: forwardQuery, branding: ctx.branding }).value,
          403,
        );
      }
      const csrfPage = renderResetPasswordPage({
        queryString: forwardQuery,
        token,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(csrfPage.value, 403);
    }

    if (!token) {
      return c.html(
        renderInvalidTokenPage({ queryString: forwardQuery, branding: ctx.branding }).value,
        400,
      );
    }

    const password = readFormString(form, "password") ?? "";
    const passwordConfirm = readFormString(form, "password_confirm") ?? "";

    const renderFormError = (error: string, status: 400 | 500) =>
      c.html(
        renderResetPasswordPage({
          queryString: forwardQuery,
          token,
          branding: ctx.branding,
          csrfToken: ctx.csrfToken,
          error,
        }).value,
        status,
      );

    if (password.length < 8) {
      return renderFormError("Le mot de passe doit contenir au moins 8 caractères.", 400);
    }
    if (password !== passwordConfirm) {
      return renderFormError("Les deux mots de passe ne correspondent pas.", 400);
    }

    const authApi = getOidcAuthApi();
    let resetResponse: Response;
    try {
      resetResponse = (await authApi.resetPassword({
        body: { newPassword: password, token },
        headers: c.req.raw.headers,
        asResponse: true,
      })) as Response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("oidc: resetPassword threw", { error: msg });
      return c.html(
        renderInvalidTokenPage({ queryString: forwardQuery, branding: ctx.branding }).value,
        400,
      );
    }

    if (!resetResponse.ok) {
      const bodyText = await resetResponse.text().catch(() => "");
      logger.warn("oidc: resetPassword !ok", {
        status: resetResponse.status,
        body: bodyText.slice(0, 200),
      });
      return c.html(
        renderInvalidTokenPage({ queryString: forwardQuery, branding: ctx.branding }).value,
        400,
      );
    }

    logger.info("oidc: password reset success");
    const successPage = renderResetPasswordPage({
      queryString: forwardQuery,
      token,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
      success: true,
    });
    return c.html(successPage.value);
  });

  const CONSENT_MISSING_CLIENT = {
    title: "Page d'autorisation invalide",
    message:
      "L'identifiant de l'application est manquant. Veuillez relancer la connexion depuis l'application.",
  };

  router.get("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, { missingClientId: CONSENT_MISSING_CLIENT });
    if (page instanceof Response) return page;
    const { url, ctx } = page;
    const scope = url.searchParams.get("scope") ?? "openid";

    // First-party clients skip the consent screen — the user already trusts
    // the platform SPA or an admin-designated first-party app.
    if (ctx.client.isFirstParty) {
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
          const errorPage = renderErrorPage({
            title: "Vérification requise",
            message:
              "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
          });
          return c.html(errorPage.value, 409);
        }
        throw err;
      }
    }

    const scopes = scope.split(/\s+/).filter(Boolean);
    const body = renderConsentPage({
      clientName: ctx.client.name ?? ctx.client.clientId,
      scopes,
      action: `/api/oauth/consent${url.search}`,
      branding: ctx.branding,
      csrfToken: ctx.csrfToken,
    });
    return c.html(body.value);
  });

  router.post("/api/oauth/consent", rateLimitByIp(60), async (c) => {
    const page = await loadPageContext(c, { missingClientId: CONSENT_MISSING_CLIENT });
    if (page instanceof Response) return page;
    const { url, ctx } = page;

    const form = await c.req.parseBody();
    if (!verifyCsrfToken(c, readFormString(form, "_csrf"))) {
      // Re-render the consent page instead of returning JSON — the user
      // submitted a form (browser context), not an API call.
      const scope = url.searchParams.get("scope") ?? "openid";
      const body = renderConsentPage({
        clientName: ctx.client.name ?? ctx.client.clientId,
        scopes: scope.split(/\s+/).filter(Boolean),
        action: `/api/oauth/consent${url.search}`,
        branding: ctx.branding,
        csrfToken: ctx.csrfToken,
        error: "Votre session a expiré. Veuillez réessayer.",
      });
      return c.html(body.value, 403);
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
        const loginPage = renderLoginPage({
          queryString: `?${oauthQuery}`,
          branding: ctx.branding,
          csrfToken: ctx.csrfToken,
          socialProviders: ctx.socialProviders,
          smtpEnabled: ctx.features.smtp,
          allowSignup: allowSignupForClient(ctx.client),
          error:
            "Un compte existe déjà avec cet email mais n'est pas vérifié. Vérifiez votre email avant de vous connecter.",
        });
        return c.html(loginPage.value, 409);
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
      const client = await getClientCached(clientId);
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

function prefersHtml(acceptHeader: string | undefined | null): boolean {
  if (!acceptHeader) return false;
  const lower = acceptHeader.toLowerCase();
  if (lower.includes("application/json")) return false;
  return lower.includes("text/html") || lower.includes("*/*");
}

async function maybeJsonRedirectToLocation(
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

/**
 * Strip reset-password-specific params (`token`, `error`) from the query
 * string so links back to the login / forgot-password pages don't leak a
 * stale token or error flag.
 */
function stripResetParams(params: URLSearchParams): string {
  const clone = new URLSearchParams(params);
  clone.delete("token");
  clone.delete("error");
  const s = clone.toString();
  return s ? `?${s}` : "";
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
