// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { createTransport, type Transporter } from "nodemailer";
import { and, eq, gt } from "drizzle-orm";
import { renderEmail } from "@appstrate/emails";
import { createLogger } from "@appstrate/core/logger";

const logger = createLogger("info");
import type { BeforeSignupContext, AfterSignupContext } from "@appstrate/core/module";
import { db } from "./client.ts";
import * as schema from "./schema.ts";
import { profiles, orgInvitations, user } from "./schema.ts";
import { getEnv } from "@appstrate/env";
import {
  evaluateSignupPolicy,
  isAllowedSignupDomain,
  isBootstrapOwner,
  normalizeEmail,
} from "./auth-policy.ts";
import { createBootstrapOrg } from "./bootstrap-org.ts";

/**
 * True when a `pending` non-expired invitation exists for `email`. Used by
 * the platform signup gate to let invited users complete signup even when
 * `AUTH_DISABLE_SIGNUP=true`. The single SQL query keeps overhead
 * negligible — the `idx_org_invitations_email` index covers it.
 */
async function hasPendingInvitationByEmail(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .select({ id: orgInvitations.id })
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.email, normalized),
        eq(orgInvitations.status, "pending"),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Post-bootstrap side-effect hook (issue #228). Fires once `createBootstrapOrg`
 * has actually inserted the org row — never on the idempotent no-op path.
 * apps/api wires this at boot to (a) emit `onOrgCreate` so cloud free-tier
 * and other module listeners observe the bootstrap org, and (b) provision
 * the default application + hello-world agent so the post-signup onboarding
 * path lands on a usable workspace, mirroring `POST /api/orgs`.
 *
 * Lives as an injection slot rather than a direct call because the
 * platform service layer (applications, default-agent, module event bus)
 * lives in `apps/api`, which `packages/db` cannot import without inverting
 * the dependency graph.
 */
export interface PostBootstrapOrgInfo {
  orgId: string;
  slug: string;
  userId: string;
  userEmail: string;
}

let _postBootstrapOrgHook: ((info: PostBootstrapOrgInfo) => Promise<void>) | null = null;

export function setPostBootstrapOrgHook(hook: (info: PostBootstrapOrgInfo) => Promise<void>): void {
  _postBootstrapOrgHook = hook;
}

/**
 * Auto-create the bootstrap organization when the freshly-signed-up user
 * matches `AUTH_BOOTSTRAP_OWNER_EMAIL`. Delegates the idempotent create-or-noop
 * to `createBootstrapOrg`, which is shared with `apps/api/scripts/bootstrap-org.ts`.
 *
 * Runs in the BA `after` hook, after the profile row is inserted. Errors are
 * swallowed (logged): the user is already created and can be recovered via
 * the explicit `bootstrap-org.ts` script if the auto-path fails transiently.
 *
 * Realm-guarded: only fires for `platform` realm signups. Without this guard,
 * an OIDC end-user flow that happens to target `AUTH_BOOTSTRAP_OWNER_EMAIL`
 * (`realm = end_user:<applicationId>`) would provision a platform org for an
 * end-user, mixing audiences that the realm separation exists to keep apart.
 */
async function maybeBootstrapOrgForOwner(
  userId: string,
  email: string,
  realm: string,
): Promise<void> {
  if (realm !== "platform") return;
  if (!isBootstrapOwner(email)) return;
  const env = getEnv();
  try {
    const result = await createBootstrapOrg(userId, env.AUTH_BOOTSTRAP_ORG_NAME);
    if (!result.created) return;
    logger.info("auth: bootstrap org created for AUTH_BOOTSTRAP_OWNER_EMAIL", {
      userId,
      email,
      orgId: result.orgId,
      slug: result.slug,
    });
    if (_postBootstrapOrgHook) {
      // Side effects (event emit, default app, default agent) run in
      // apps/api. Failures here are logged but never break signup — the
      // org itself is already committed.
      try {
        await _postBootstrapOrgHook({
          orgId: result.orgId,
          slug: result.slug,
          userId,
          userEmail: email,
        });
      } catch (err) {
        logger.error("auth: post-bootstrap hook failed", {
          userId,
          email,
          orgId: result.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("auth: bootstrap org creation failed", {
      userId,
      email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Env is read lazily inside `buildAuth()` rather than at module load time so
// that `_rebuildAuthForTesting()` can flip SMTP / social flags between tests
// without having to reload the module. All env-dependent derivations
// (`smtpEnabled`, `smtpTransport`, `socialProviders`, `basePlugins`) live
// inside `buildAuth()` for the same reason.

// ─── Signup hooks (injected at boot via module system) ───
//
// The platform exposes single injection slots consumed by the module
// loader (`apps/api/src/lib/boot.ts`) which fans out to every registered
// module's `beforeSignup` / `afterSignup` hook. Both signatures carry a
// `ctx` with the request headers so modules that need to read request
// state (e.g. the OIDC pending-client cookie in `auth/signup-guard.ts`)
// can do so without adding a parallel hook channel.

let _beforeSignupHook: ((email: string, ctx: BeforeSignupContext) => void | Promise<void>) | null =
  null;

let _afterSignupHook:
  ((user: { id: string; email: string }, ctx: AfterSignupContext) => void | Promise<void>) | null =
  null;

export function setBeforeSignupHook(
  hook: (email: string, ctx: BeforeSignupContext) => void | Promise<void>,
): void {
  _beforeSignupHook = hook;
}

// ─── Realm resolver (injected at boot, typically by the OIDC module) ───
//
// Decides the `user.realm` value assigned to a brand-new Better Auth user
// row at creation time. The default ("platform") covers every signup flow
// driven by the platform itself (dashboard signup, org invitation, direct
// BA sign-up). The OIDC module overrides this via `setRealmResolver()`
// during its `init()` to return `"end_user:<applicationId>"` whenever the
// in-flight signup is bound to an application-level OAuth client — the
// single-user-pool isolation fix that prevents end-user sessions from
// being replayed against platform routes.
//
// Async signature so the resolver can look up the OAuth client's policy
// (which includes `applicationId`) in the short-TTL cache — same plumbing
// as `oidcBeforeSignupGuard`.
//
// The resolver receives the full request-scoped view Better Auth exposes to
// database hooks (CRIT-15): `headers` alone is NOT enough to bind the realm
// to the OAuth transaction on the BA-driven create legs. The social
// callback (`/callback/:id`) identifies its transaction by the OAuth
// `state` (readable server-side via BA's request-scoped OAuth state), and
// the magic-link verify leg (`/magic-link/verify`) identifies its
// transaction by the single-use `token` in `query`. `path` + `query` let
// the resolver key into server-side bindings the browser cannot strip or
// forge, instead of trusting an ambient cookie.

export interface RealmResolutionContext {
  /** Request headers — `null` when BA creates the user outside HTTP (seeds, scripts). */
  headers: Headers | null;
  /**
   * Better Auth endpoint route pattern driving the user creation (e.g.
   * `"/sign-up/email"`, `"/callback/:id"`, `"/magic-link/verify"`), when
   * known.
   */
  path: string | null;
  /** Concrete query params of that endpoint invocation, when known. */
  query: Record<string, unknown> | null;
}

export type RealmResolver = (ctx: RealmResolutionContext) => Promise<string>;

let _realmResolver: RealmResolver | null = null;

export function setRealmResolver(resolver: RealmResolver): void {
  _realmResolver = resolver;
}

// ─── Magic-link issued hook (injected at boot by the OIDC module) ───
//
// Fired from the magic-link plugin's `sendMagicLink` callback BEFORE the
// email leaves the transport, with the freshly minted single-use token and
// the request headers of the `sign-in/magic-link` call. The OIDC module
// uses it to persist a server-side `(token → OAuth client)` binding so the
// later `/magic-link/verify` leg — driven entirely by Better Auth — can
// resolve the user's realm from state the browser cannot strip or forge
// (CRIT-15).
//
// FAIL CLOSED contract: if the hook throws, the email is NOT sent (the
// surrounding try/catch in `sendMagicLink` aborts before `sendMail`). An
// OIDC-initiated magic link must never go out without its binding.

export interface MagicLinkIssuedInfo {
  /** The single-use magic-link token embedded in the emailed URL. */
  token: string;
  /** Normalized (lowercased/trimmed) recipient email. */
  email: string;
  /** Headers of the `sign-in/magic-link` request — `null` outside HTTP. */
  headers: Headers | null;
}

let _magicLinkIssuedHook: ((info: MagicLinkIssuedInfo) => Promise<void>) | null = null;

export function setMagicLinkIssuedHook(hook: (info: MagicLinkIssuedInfo) => Promise<void>): void {
  _magicLinkIssuedHook = hook;
}

// ─── SMTP override (per-request) ─────────────────────────────────────────────
//
// Flows driven by a `level=application` OIDC client must send verification
// emails, magic-links, and password-reset mails through the TENANT's SMTP
// transport, not the instance env transport. The Better Auth singleton is
// built once at boot with callbacks that capture `smtpTransport` by closure
// — we cannot rebuild BA per request without defeating its plugin/cache
// assumptions. Instead, the OIDC module wraps each BA call in
// `withSmtpOverride(override, fn)`; the callbacks below look up
// `getSmtpOverride()` on every invocation and use the override's transport
// + `from` when present, falling back to the captured env transport for all
// other code paths (admin dashboard, org invitations, instance clients).

export interface SmtpOverride {
  transport: Transporter;
  fromAddress: string;
  fromName: string | null;
}

const smtpOverrideStore = new AsyncLocalStorage<SmtpOverride>();

// ─── Bootstrap-token redemption (per-request bypass) ─────────────────────────
//
// `AUTH_BOOTSTRAP_TOKEN` (issue #344 Layer 2b) ships an instance with
// `AUTH_DISABLE_SIGNUP=true` so a fresh `curl|bash -s -- --yes` install
// is closed by default. The redemption route (`POST
// /api/auth/bootstrap/redeem`) needs to bypass that gate exactly once,
// for exactly the request that submitted a valid token. AsyncLocalStorage
// scoped to the redeem route's call to `auth.api.signUpEmail()` is the
// minimum-blast-radius primitive — same shape as `withSmtpOverride`.

const bootstrapTokenRedemptionStore = new AsyncLocalStorage<boolean>();

/** Run `fn` with the bootstrap-token bypass active for any signup-gate eval downstream. */
export function withBootstrapTokenRedemption<T>(fn: () => Promise<T>): Promise<T> {
  return bootstrapTokenRedemptionStore.run(true, fn);
}

/** True when the current async context is inside `withBootstrapTokenRedemption`. */
export function isBootstrapTokenRedemptionActive(): boolean {
  return bootstrapTokenRedemptionStore.getStore() === true;
}

/** Run `fn` with `override` as the active SMTP context for any BA mail callback fired downstream. */
export function withSmtpOverride<T>(
  override: SmtpOverride | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!override) return fn();
  return smtpOverrideStore.run(override, fn);
}

/** Return the active SMTP override, if any. Called from BA mail callbacks. */
export function getSmtpOverride(): SmtpOverride | undefined {
  return smtpOverrideStore.getStore();
}

function formatFrom(override: SmtpOverride): string {
  return override.fromName
    ? `"${override.fromName}" <${override.fromAddress}>`
    : override.fromAddress;
}

// ─── Social provider override (per-request) ──────────────────────────────────
//
// Flows driven by a `level=application` OIDC client must redirect through the
// TENANT's Google/GitHub OAuth App, not the platform's — so the consent
// screen shows the tenant's branding, scopes are tenant-controlled, and
// audit/revocation happen on the tenant's OAuth App. Like SMTP, we can't
// rebuild the BA singleton per request; instead the `socialProviders` entries
// below expose `clientId` / `clientSecret` as **getters** that look up an
// AsyncLocalStorage override before falling back to env. The OIDC module's
// BA `before` hook calls `enterSocialOverride()` after reading the pending-
// client cookie and resolving per-app creds — all subsequent BA property
// accesses (in Google/GitHub provider factories, validate-authorization-code,
// create-authorization-url) see the tenant's creds.
//
// BA calls its social provider factories once at init with the `options`
// object (see `@better-auth/core/social-providers/google.mjs`). Each method
// on the returned provider reads `options.clientId` / `options.clientSecret`
// lazily via property access — confirmed in the 1.6.2 source. That's why the
// getters fire at request time rather than boot time.

export interface SocialOverride {
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

const socialOverrideStore = new AsyncLocalStorage<SocialOverride>();

/**
 * Set the active social-provider override for the CURRENT async context.
 * Uses `enterWith` (not `run`) because the BA `before` hook returns void
 * and cannot wrap downstream execution — the override must persist until
 * the async context naturally unwinds.
 *
 * Isolation contract (IMPORTANT):
 *   - The override is scoped to the async chain of the BA route handler
 *     (one chain per HTTP request in Hono + Bun).
 *   - Callers MUST NOT invoke `enterSocialOverride` outside a BA social/
 *     callback route — reusing the same async context across two logical
 *     operations would leak the first override into the second.
 *   - Each new BA request enters through `createAuthMiddleware` which Bun
 *     wraps in a fresh async context, so per-request isolation holds as
 *     long as we only call this from the OIDC module's social `before`
 *     hook (see `apps/api/src/modules/oidc/services/ba-social-override-plugin.ts`).
 *   - Tested by `apps/api/src/modules/oidc/test/unit/social-override-isolation.test.ts`
 *     which exercises two concurrent requests with distinct per-app creds
 *     and asserts no cross-contamination.
 */
export function enterSocialOverride(override: SocialOverride): void {
  socialOverrideStore.enterWith(override);
}

/** Return the active social override, if any. Called from the getters below. */
export function getSocialOverride(): SocialOverride | undefined {
  return socialOverrideStore.getStore();
}

export function setAfterSignupHook(
  hook: (user: { id: string; email: string }, ctx: AfterSignupContext) => void | Promise<void>,
): void {
  _afterSignupHook = hook;
}

/**
 * Better Auth plugin list type. Exported so modules can strongly type their
 * `betterAuthPlugins()` return value without going through the `unknown[]`
 * erasure at the `@appstrate/core` contract layer.
 */
export type BetterAuthPluginList = NonNullable<Parameters<typeof betterAuth>[0]["plugins"]>;

/**
 * BA's OAuth callback endpoint path. Exposed as a constant so the create
 * hook and its unit tests reference the same string (if BA ever renames
 * the route, both sides fail together).
 */
export const BA_OAUTH_CALLBACK_PATH = "/callback/:id";

/**
 * Decide whether a `databaseHooks.user.create.before` invocation should
 * auto-verify the user's email.
 *
 * SECURITY: this must ONLY confirm verification the provider actually
 * asserted — never grant it unconditionally. BA already computes
 * `user.emailVerified` from the provider's real signal (Google's
 * `email_verified` id_token claim; GitHub's `/user/emails` verified flag).
 * We therefore auto-verify only when BOTH the request ran under BA's OAuth
 * callback endpoint AND the provider asserted the email is verified
 * (`providerAssertsVerified`). Blanket-verifying every OAuth callback let
 * an attacker link an UNVERIFIED GitHub email onto a victim's account
 * (pre-account-takeover), so the provider assertion is load-bearing.
 *
 * Returns `{ data: { emailVerified: true } }` (the shape BA's
 * `createWithHooks` merges into the row about to be inserted) when both
 * conditions hold, `undefined` otherwise — falling through to BA's own
 * `emailVerified` value for OAuth (which stays `false` for an unverified
 * provider email) and for email/password, magic-link, and seed paths.
 *
 * Exported for unit testing; the `databaseHooks.user.create.before` hook
 * inside `buildAuth()` is the only production caller.
 */
export function shouldAutoVerifyEmailOnCreate(
  context: { path?: string } | null | undefined,
  providerAssertsVerified: boolean,
): { data: { emailVerified: true } } | undefined {
  if (context?.path === BA_OAUTH_CALLBACK_PATH && providerAssertsVerified) {
    return { data: { emailVerified: true } };
  }
  return undefined;
}

function buildBasePlugins(
  env: ReturnType<typeof getEnv>,
  smtpTransport: ReturnType<typeof createTransport> | null,
) {
  const smtpEnabled = !!smtpTransport;
  return [
    ...(smtpEnabled
      ? [
          magicLink({
            // Signup via magic-link is allowed. The `databaseHooks.user.create.before`
            // chain still enforces per-context policy: the OIDC module's
            // `oidcBeforeSignupGuard` blocks creation for org-level clients with
            // `allowSignup: false` (via the signed `oidc_pending_client` cookie),
            // and cloud's free-tier hook applies its own gate. Outside an OIDC
            // flow, magic-link signup is as open as email/password signup.
            disableSignUp: false,
            // Short-lived login link. A magic-link is a bearer credential: a
            // 7-day window let an attacker who later gained read access to the
            // recipient's inbox (forwarded mail, shared/compromised mailbox,
            // mail-archive breach) replay the link and take over the account.
            // 15 minutes is enough for a human to click through immediately
            // while closing the replay window. `allowedAttempts` still lets
            // email prefetchers hit the URL without burning the token early.
            expiresIn: 15 * 60, // 15 minutes
            allowedAttempts: 5, // Browsers may hit verify multiple times (prefetch, preconnect)
            sendMagicLink: async ({ email, url: rawUrl, token }, mlCtx) => {
              try {
                const normalizedEmail = email.toLowerCase().trim();

                // Give the OIDC module a chance to persist the server-side
                // `(token → OAuth client)` transaction binding BEFORE the
                // email is sent (see `setMagicLinkIssuedHook`). A throw here
                // aborts the send via the surrounding catch — fail closed:
                // an OIDC magic link must never leave without its binding,
                // otherwise the verify leg would fall back to forgeable
                // browser state for realm resolution (CRIT-15).
                if (_magicLinkIssuedHook) {
                  // `EndpointContext.headers` is typed `HeadersInit` — copy
                  // into a real `Headers` so the hook contract stays uniform
                  // with the other signup-hook channels.
                  const rawHeaders = mlCtx?.headers ?? mlCtx?.request?.headers ?? null;
                  await _magicLinkIssuedHook({
                    token,
                    email: normalizedEmail,
                    headers: rawHeaders ? new Headers(rawHeaders) : null,
                  });
                }

                // Rewrite the verify URL to route through the OIDC module's
                // confirmation interstitial so that one-shot token consumption
                // is gated behind an explicit click. Without this, email
                // clients (Resend click-tracking, Outlook SafeLinks, Gmail
                // preview, Apple Mail preview, corporate URL scanners)
                // prefetch the `GET` link and burn the token before the user
                // clicks — producing a `session_expired` on the relying-party
                // callback. Mirrors Slack/Notion/Linear/Supabase.
                //
                // The confirm page lives in the OIDC module but is generic
                // (falls back to platform branding when the callbackURL has
                // no client_id, e.g. invitation flows).
                const rewritten = new URL(rawUrl);
                if (rewritten.pathname === "/api/auth/magic-link/verify") {
                  rewritten.pathname = "/api/oauth/magic-link/confirm";
                  // Surface the recipient email on the confirm interstitial
                  // ("You are signing in as foo@bar.com") to match SOTA UX
                  // (Slack/Linear). Safe: the recipient already owns the
                  // email, and the URL is only delivered to their inbox.
                  rewritten.searchParams.set("email", normalizedEmail);
                } else {
                  // Defense against a silent BA path change in future upgrades.
                  // If the path ever moves, the rewrite above becomes a no-op
                  // and we'd regress to prefetch-vulnerable behavior — log
                  // loudly so the drift is caught in ops before it reaches
                  // users.
                  logger.warn(
                    "oidc: magic-link URL rewrite skipped — unexpected BA path, falling back to direct verify",
                    { pathname: rewritten.pathname },
                  );
                }
                const url = rewritten.toString();

                // Magic-link is now a pure passwordless-login channel. The
                // invitation flow no longer rides on magic-link: an invited
                // user opens the `/invite/{token}` page and authenticates
                // through the standard login/signup path, then accepts. So a
                // single generic template covers every magic-link send.
                const { subject, html } = renderEmail("magic-link", {
                  email: normalizedEmail,
                  url,
                  locale: "fr",
                });

                const override = getSmtpOverride();
                const transport = override?.transport ?? smtpTransport!;
                const from = override ? formatFrom(override) : env.SMTP_FROM;
                await transport.sendMail({ from, to: email, subject, html });
              } catch {
                // Fire-and-forget
              }
            },
          }),
        ]
      : []),
  ];
}

// ─── Auth — lazy factory ──────────────────────────────────
//
// The Better Auth instance is constructed lazily by `createAuth()` during
// boot, AFTER modules have registered their plugin contributions via
// `AppstrateModule.betterAuthPlugins()`. Module tables live in the core
// schema (resolved from the barrel), so no per-module schema merge is
// needed. All consumers must call `getAuth()` at request time / post-boot
// — never at module-evaluation time.
//
// Test harness: `test/setup/preload.ts` calls `createAuth([])` during
// preload so module test runs boot cleanly.

function buildAuth(extraPlugins: BetterAuthPluginList = []) {
  const env = getEnv();
  const smtpEnabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
  // Tests set `SMTP_HOST=__test_json__` to exercise the SMTP-enabled BA flow
  // (requireEmailVerification, sendOnSignUp, sendOnSignIn, …) without
  // needing an actual SMTP server. Nodemailer's `jsonTransport` accepts
  // every message and returns the serialized payload immediately, which
  // keeps BA's `runInBackgroundOrAwait` from hanging in tests.
  const smtpTransport = smtpEnabled
    ? env.SMTP_HOST === "__test_json__"
      ? createTransport({ jsonTransport: true })
      : createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        })
    : null;
  const googleEnvEnabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const githubEnvEnabled = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  // Both providers are ALWAYS registered on BA so per-app credentials
  // injected via `enterSocialOverride()` (OIDC module plugin, see
  // `apps/api/src/modules/oidc/services/ba-social-override-plugin.ts`) have a
  // live provider factory to flow through — even when the env vars are
  // absent. At the call site the getter returns the override's value if
  // present, else the env value, else the empty string (which makes the
  // provider's own guard throw `CLIENT_ID_AND_SECRET_REQUIRED` — the BA
  // error surfaced to the UI when a tenant hasn't configured creds).
  //
  // `anySocialEnabled` still gates account-linking + trusted providers on
  // env-configured providers only: per-app social applies exclusively to
  // `level=application` OIDC clients, which have their own auth surface —
  // the instance-wide account linking flag is an env concern.
  const anySocialEnabled = googleEnvEnabled || githubEnvEnabled;
  const socialProviders: Record<
    string,
    {
      clientId: string;
      clientSecret: string;
      mapProfileToUser?: (profile: unknown) => { emailVerified?: boolean };
    }
  > = {
    google: {
      get clientId() {
        return getSocialOverride()?.google?.clientId ?? env.GOOGLE_CLIENT_ID ?? "";
      },
      get clientSecret() {
        return getSocialOverride()?.google?.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? "";
      },
      // Google asserts `email_verified` in its OIDC id_token and BA maps it
      // onto `user.emailVerified` (see `@better-auth/core` google provider).
      // Google never issues a token for an email the user hasn't proven
      // ownership of, so treating a successful Google round-trip as
      // verified is safe. We keep the explicit override only for Google.
      //
      // SECURITY: we do NOT do the same for GitHub. GitHub lets a user add
      // an UNVERIFIED email to their account, and BA already computes the
      // real per-email verified flag from `/user/emails`
      // (`emails.find(e => e.email === profile.email)?.verified ?? false`).
      // Blanket-setting `emailVerified: true` there clobbered that real
      // signal and opened a pre-account-takeover: an attacker adds the
      // victim's email (unverified) to a GitHub account, signs in, and —
      // because the email is (falsely) "verified" — BA account-links it to
      // the victim's existing user (trusted provider + matching email),
      // handing the attacker the account. Leaving GitHub without an
      // override lets BA's genuine verified flag decide linking.
      mapProfileToUser: () => ({ emailVerified: true }),
    },
    github: {
      get clientId() {
        return getSocialOverride()?.github?.clientId ?? env.GITHUB_CLIENT_ID ?? "";
      },
      get clientSecret() {
        return getSocialOverride()?.github?.clientSecret ?? env.GITHUB_CLIENT_SECRET ?? "";
      },
      // No `mapProfileToUser` override on purpose — see the GitHub note above.
      // BA sets `emailVerified` from GitHub's real `/user/emails` verified
      // flag; forcing it true here would defeat the takeover guard.
    },
  };
  const basePlugins = buildBasePlugins(env, smtpTransport);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { ...schema },
    }),

    baseURL: env.APP_URL,
    basePath: "/api/auth",
    // Resolve the secret through the kid map so a deployment that has
    // already populated `BETTER_AUTH_SECRETS` for cookie rotation feeds
    // Better Auth the active secret (not the legacy single-value var).
    secret: env.BETTER_AUTH_SECRETS[env.BETTER_AUTH_ACTIVE_KID] ?? env.BETTER_AUTH_SECRET,

    // Route Better Auth's internal logs through our structured pino logger
    // instead of its default console writer (repo rule: no console.*). Only
    // warn/error reach this sink (BA's default level), so the volume matches
    // the prior console output — it's just redirected and JSON-structured.
    //
    // Suppress one construction-time false positive: the google/github social
    // providers below are registered with empty placeholder creds ON PURPOSE
    // so the per-app OIDC social override (`enterSocialOverride`) has a live
    // provider factory to flow tenant creds through at request time. BA's
    // `!clientId` guard runs once at construction and can't see that
    // request-time override, so "Social provider … is missing clientId or
    // clientSecret" is noise here, not an actionable warning.
    logger: {
      log: (level, message, ...args) => {
        if (
          level === "warn" &&
          /^Social provider \w+ is missing clientId or clientSecret$/.test(message)
        ) {
          return;
        }
        // BA emits levels our pino logger doesn't implement as methods
        // (e.g. "success") — indexing `logger[level]` with one of those
        // would call `undefined(...)` and throw. Map anything outside the
        // pino method set to "info" so the bridge is always safe.
        const method =
          level === "debug" || level === "info" || level === "warn" || level === "error"
            ? level
            : "info";
        logger[method](message, args.length > 0 ? { args } : undefined);
      },
    },

    plugins: [...basePlugins, ...extraPlugins],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: smtpEnabled,
      // Test-only fast password hasher. Better Auth's default is scrypt
      // (deliberately slow — ~35ms/hash), which dominates the test suite since
      // most tests sign up a real user per `beforeEach`. When the test harness
      // sets AUTH_FAST_TEST_HASH=1 (see test/setup/preload.ts), swap in a plain
      // SHA-256 hash: the round-trip (hash→verify) still works, so every auth
      // code path keeps full coverage — only the (irrelevant-to-tests) hash
      // strength changes. Hard-gated on NODE_ENV !== "production" so a leaked
      // flag can never weaken real password hashing in a production deployment.
      ...(process.env.AUTH_FAST_TEST_HASH === "1" &&
        process.env.NODE_ENV !== "production" && {
          password: {
            hash: async (password: string): Promise<string> =>
              new Bun.CryptoHasher("sha256").update(password).digest("hex"),
            verify: async ({
              hash,
              password,
            }: {
              hash: string;
              password: string;
            }): Promise<boolean> =>
              new Bun.CryptoHasher("sha256").update(password).digest("hex") === hash,
          },
        }),
      ...(smtpEnabled && {
        sendResetPassword: async ({ user, url }) => {
          try {
            const { subject, html } = renderEmail("reset-password", {
              email: user.email,
              url,
              locale: "fr",
            });
            const override = getSmtpOverride();
            const transport = override?.transport ?? smtpTransport!;
            const from = override ? formatFrom(override) : env.SMTP_FROM;
            await transport.sendMail({ from, to: user.email, subject, html });
          } catch {
            // Fire-and-forget — don't block reset flow if email fails
          }
        },
      }),
    },

    ...(smtpEnabled && {
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
          try {
            const { subject, html } = renderEmail("verification", {
              user,
              url,
              locale: "fr",
            });
            const override = getSmtpOverride();
            const transport = override?.transport ?? smtpTransport!;
            const from = override ? formatFrom(override) : env.SMTP_FROM;
            await transport.sendMail({ from, to: user.email, subject, html });
          } catch {
            // Fire-and-forget — don't block signup if email fails
          }
        },
      },
    }),

    socialProviders,

    account: {
      accountLinking: {
        enabled: anySocialEnabled,
        trustedProviders: [
          ...(googleEnvEnabled ? ["google" as const] : []),
          ...(githubEnvEnabled ? ["github" as const] : []),
        ],
        allowDifferentEmails: true,
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Refresh every 24h
      // Disabled to work around BA 1.6 issue #7607 — when `session_data`
      // expires (at `maxAge`), BA fails to regenerate it from the still-valid
      // `session_token` under certain plugin configurations, logging the
      // user out at the next request. Still open in 1.6.3.
      // Re-enable once the upstream bug is fixed. Cost of disabling: one
      // extra DB query per authenticated request (negligible at our scale).
      // Verified none of our plugins (`@better-auth/oauth-provider`, `jwt`)
      // depend on `session_data` — only `email-otp` does, which we don't use.
      cookieCache: { enabled: false },
      additionalFields: {
        // Denormalized from `user.realm` by `databaseHooks.session.create.before`.
        // Same reason as `user.additionalFields.realm`: BA's adapter strips
        // columns not declared here.
        realm: { type: "string", required: false, input: false },
      },
    },

    user: {
      additionalFields: {
        // `realm` is set by `databaseHooks.user.create.before` via the
        // injected realm resolver (see `setRealmResolver`). Declared here
        // so BA's drizzle adapter doesn't strip it out of the create
        // payload — BA filters the INSERT data against its own derived
        // schema, which only includes columns declared via
        // `additionalFields`. Without this, the `{ data: { realm } }`
        // returned from the before-hook never reaches the DB and every
        // new user falls back to the SQL default ("platform").
        realm: { type: "string", required: false, input: false },
      },
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: !smtpEnabled,
      },
    },

    trustedOrigins: env.TRUSTED_ORIGINS,

    advanced: {
      // Explicit per-cookie defaults — Better Auth applies these to the
      // session cookie + every plugin-issued cookie (CSRF, etc.). Pinning
      // them here removes "what does BA's default do?" from every
      // security audit.
      //
      //   sameSite: "lax"   — allows top-level GET nav with the session
      //                       (link clicks from email, social cards) but
      //                       blocks cross-origin form-POSTs that could
      //                       mount a CSRF amplifier on top of
      //                       `cors({ credentials: true })`.
      //   secure:   true    — forbids the cookie from leaving the TLS
      //                       boundary. Browsers tolerate `Secure` on
      //                       http://localhost in dev, so this is safe to
      //                       hard-code on rather than gating on
      //                       NODE_ENV.
      //   httpOnly: true    — already BA's default; reasserted for
      //                       consistency.
      //   partitioned: true — opt-in to CHIPS so an embedded portal
      //                       iframe gets its own cookie jar (Chromium /
      //                       Edge / Firefox 128+); browsers that don't
      //                       implement CHIPS just ignore the attribute.
      defaultCookieAttributes: {
        sameSite: "lax" as const,
        secure: true,
        httpOnly: true,
        partitioned: true,
      },
      ...(env.COOKIE_DOMAIN
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: env.COOKIE_DOMAIN,
            },
          }
        : {}),
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const ctx = context as
              | {
                  headers?: Headers;
                  request?: { headers?: Headers };
                  path?: string;
                  query?: Record<string, unknown>;
                }
              | null
              | undefined;
            // BA stores request headers in two possible locations depending
            // on the code path: `context.headers` for email/password signup,
            // `context.request.headers` for social OAuth callbacks. Match
            // BA's own fallback chain (see internal-adapter.mjs) — missing
            // this second path was the bug that let social signups bypass
            // the OIDC `beforeSignup` guard. `context` is `null` when BA
            // creates users outside an HTTP request (seeds, admin scripts).
            const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
            // Platform-level signup gate (self-hosting lockdown). Runs FIRST
            // so the cheapest, most specific decision wins before any module
            // hook. A pending invitation overrides BOTH closed mode and the
            // domain allowlist (see `invited` below).
            const envForGate = getEnv();
            // Bootstrap-token redemption (#344 Layer 2b) — explicitly
            // bypasses the `AUTH_DISABLE_SIGNUP` gate. The redeem route
            // has already verified a single-use 256-bit token against
            // `env.AUTH_BOOTSTRAP_TOKEN` via timing-safe compare; trying
            // to also satisfy `evaluateSignupPolicy` would force the
            // operator to also ship `AUTH_PLATFORM_ADMIN_EMAILS`, which
            // defeats the point of "no email needed at install time".
            //
            // The bypass is SCOPED — it covers only the closed-mode
            // gate (`AUTH_DISABLE_SIGNUP`). An active domain allowlist
            // (`AUTH_ALLOWED_SIGNUP_DOMAINS`) remains load-bearing
            // because the operator explicitly chose to lock down which
            // emails can register; the bootstrap owner must satisfy
            // that policy too. A pending invitation also overrides
            // both gates (Infisical-style breakage avoidance), matching
            // the non-bypass evaluator's logic.
            const bootstrapTokenBypass = isBootstrapTokenRedemptionActive();
            // A pending invitation for this exact email overrides the signup
            // gate (Infisical-style breakage avoidance) so an invited user can
            // complete signup even when signup is locked down. It is matched on
            // EMAIL ALONE — the invitation token is not available at signup —
            // so it is NOT proof of inbox ownership (it only means an org admin
            // typed this address) and must NEVER auto-verify the email. See the
            // `emailVerified` decision below. The lookup is index-covered
            // (`idx_org_invitations_email`); signups are infrequent, so the
            // unconditional query is negligible.
            const invited = await hasPendingInvitationByEmail(user.email);
            const gateActive =
              envForGate.AUTH_DISABLE_SIGNUP || envForGate.AUTH_ALLOWED_SIGNUP_DOMAINS.length > 0;
            if (gateActive) {
              if (bootstrapTokenBypass) {
                if (envForGate.AUTH_ALLOWED_SIGNUP_DOMAINS.length > 0 && !invited) {
                  if (!isAllowedSignupDomain(user.email)) {
                    logger.info("auth: bootstrap-token bypass blocked by domain allowlist", {
                      email: user.email,
                    });
                    throw new APIError("FORBIDDEN", {
                      message: "signup_domain_not_allowed",
                      code: "signup_domain_not_allowed",
                    });
                  }
                }
              } else {
                const decision = evaluateSignupPolicy(user.email, invited);
                if (!decision.allowed) {
                  logger.info("auth: platform signup gate blocked signup", {
                    email: user.email,
                    reason: decision.reason,
                  });
                  throw new APIError("FORBIDDEN", {
                    message: decision.reason,
                    code: decision.reason,
                  });
                }
              }
            }
            // Forward the transaction-scoped view (path + query, on top of
            // headers) so module hooks can bind their decisions to the OAuth
            // transaction rather than an ambient cookie — see
            // `RealmResolutionContext`. The extra fields ride alongside the
            // `BeforeSignupContext` contract; modules that only read
            // `headers` are unaffected.
            const signupHookCtx: BeforeSignupContext & {
              path: string | null;
              query: Record<string, unknown> | null;
            } = { headers, path: ctx?.path ?? null, query: ctx?.query ?? null };
            if (_beforeSignupHook) {
              await _beforeSignupHook(user.email, signupHookCtx);
            }
            // Merge realm resolution + email auto-verify into a single data
            // patch returned to BA. The realm resolver falls back to
            // "platform" when no OIDC module is loaded (OSS mode).
            //
            // Bootstrap-token redeem (#344) FORCES "platform": the redeem
            // route forwards `c.req.raw.headers` to BA, and a stray
            // `oidc_pending_client` cookie on that request would otherwise
            // route the bootstrap owner into an end-user realm — wrong
            // audience for an instance-owner row, and unrecoverable once
            // committed. Bypass the resolver entirely on this path.
            const realm = bootstrapTokenBypass
              ? "platform"
              : _realmResolver
                ? await _realmResolver({
                    headers,
                    path: ctx?.path ?? null,
                    query: ctx?.query ?? null,
                  })
                : "platform";
            // Auto-verify ONLY when a trusted social provider produced the row
            // (the BA OAuth callback path) AND the provider itself asserted the
            // email is verified. BA has already set `user.emailVerified` from
            // the provider's real signal (Google `email_verified` claim /
            // GitHub `/user/emails` verified flag), so we pass that through as
            // the gate — we never upgrade an unverified provider email to
            // verified (which would enable GitHub-unverified-email account
            // takeover). A pending invitation is likewise NOT a verification
            // signal: it is matched on email alone, so granting `emailVerified`
            // here would let anyone mint a verified account for any unclaimed
            // address (create org → self-invite that email → sign up) AND would
            // defeat the OIDC end-user adopter's `emailVerified === true`
            // takeover guard. Invited users verify their inbox through the
            // normal flow, like everyone else.
            const providerAssertsVerified =
              (user as { emailVerified?: boolean }).emailVerified === true;
            const autoVerify = shouldAutoVerifyEmailOnCreate(ctx, providerAssertsVerified);
            const data: Record<string, unknown> = { realm };
            if (autoVerify) data.emailVerified = true;
            return { data };
          },
          after: async (user, context) => {
            await db.insert(profiles).values({
              id: user.id,
              displayName: user.name || user.email,
              language: "fr",
            });
            // Read the realm written by the before-hook. BA's drizzle adapter
            // returns the inserted row, so `user.realm` is populated when the
            // additionalField is declared. Fall back to "platform" if the
            // adapter strips it (defensive — the SQL default matches anyway).
            const realm = (user as { realm?: string }).realm ?? "platform";
            // Self-hosting bootstrap path (issue #228) — auto-create the
            // root org for AUTH_BOOTSTRAP_OWNER_EMAIL. Idempotent. Runs
            // BEFORE the module after-hook so cloud's free-tier hook etc.
            // see a coherent state.
            try {
              await maybeBootstrapOrgForOwner(user.id, user.email, realm);
            } catch (err) {
              logger.error("auth: bootstrap org creation failed", {
                userId: user.id,
                email: user.email,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            if (_afterSignupHook) {
              const ctx = context as
                | {
                    headers?: Headers;
                    request?: { headers?: Headers };
                    path?: string;
                    query?: Record<string, unknown>;
                  }
                | null
                | undefined;
              const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
              // Same transaction-scoped extension as the before-hook — lets
              // the OIDC after-signup handler resolve the in-flight OAuth
              // client from the transaction binding instead of the cookie.
              const afterCtx: AfterSignupContext & {
                path: string | null;
                query: Record<string, unknown> | null;
              } = { headers, path: ctx?.path ?? null, query: ctx?.query ?? null };
              await _afterSignupHook({ id: user.id, email: user.email }, afterCtx);
            }
          },
        },
      },
      session: {
        create: {
          // Denormalize `user.realm` onto the session row so the request-time
          // realm guard in the auth pipeline (`requirePlatformRealm`) can
          // reject mismatched audiences without an extra user-table lookup
          // on every request. BA creates the session row by INSERT — we
          // return a patch to merge the realm before the write.
          before: async (sess) => {
            const [row] = await db
              .select({ realm: user.realm })
              .from(user)
              .where(eq(user.id, sess.userId))
              .limit(1);
            // If the user row vanished between session insert and our SELECT
            // (shouldn't happen — BA inserts the user before the session in
            // the same flow), fall back to "platform". The request-time guard
            // then treats the session as platform-scoped, which is safer than
            // leaking an end-user session.
            return { data: { realm: row?.realm ?? "platform" } };
          },
        },
      },
    },
  });
}

// ─── Factory + lazy singleton ────────────────────────────

type AuthInstance = ReturnType<typeof buildAuth>;

let _auth: AuthInstance | null = null;
let _lastExtraPlugins: BetterAuthPluginList = [];

/**
 * Construct the Better Auth singleton. Idempotent — subsequent calls are
 * no-ops. Must be called once during boot, after modules have loaded, so
 * that any plugins contributed via `AppstrateModule.betterAuthPlugins()`
 * are merged with `basePlugins`. Module tables already live in the core
 * schema, so the Drizzle adapter resolves them from the barrel directly.
 */
export function createAuth(extraPlugins: BetterAuthPluginList = []): void {
  if (_auth) return;
  _lastExtraPlugins = extraPlugins;
  _auth = buildAuth(extraPlugins);
}

/**
 * Test-only: rebuild the Better Auth singleton with the CURRENT env. Lets
 * tests flip SMTP / social / cookie-domain flags at runtime and verify the
 * resulting behavior (email-verification flow, social auto-verify hook,
 * …). The extra plugins + drizzle schemas passed to the most recent
 * `createAuth()` call are re-used so modules don't need to re-register.
 *
 * DO NOT call this from production code — it defeats the whole point of
 * the idempotent singleton. It exists solely so the module test preload
 * can opt certain test files into an SMTP-enabled auth instance without
 * having to reload the entire process.
 */
export function _rebuildAuthForTesting(): void {
  _auth = buildAuth(_lastExtraPlugins);
}

/** Get the Better Auth instance. Throws if `createAuth()` has not yet run. */
export function getAuth(): AuthInstance {
  if (!_auth) {
    throw new Error(
      "auth not initialized — createAuth() must run during boot before any auth access",
    );
  }
  return _auth;
}
