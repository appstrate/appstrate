// SPDX-License-Identifier: Apache-2.0

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { createTransport } from "nodemailer";
import { eq } from "drizzle-orm";
import { renderEmail } from "@appstrate/emails";
import { db } from "./client.ts";
import * as schema from "./schema.ts";
import { profiles, orgInvitations, organizations, user } from "./schema.ts";
import { getEnv } from "@appstrate/env";

const env = getEnv();

// ─── Before-signup hook (injected at boot via module system) ───

let _beforeSignupHook: ((email: string) => void | Promise<void>) | null = null;

export function setBeforeSignupHook(hook: (email: string) => void | Promise<void>): void {
  _beforeSignupHook = hook;
}

// ─── SMTP transport (lazy, only if configured) ─────────────

const smtpEnabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);

const smtpTransport = smtpEnabled
  ? createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
  : null;

// ─── Social providers (only if configured) ──────────────

const googleEnabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const githubEnabled = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const anySocialEnabled = googleEnabled || githubEnabled;

const socialProviders: Record<string, { clientId: string; clientSecret: string }> | undefined =
  anySocialEnabled
    ? {
        ...(googleEnabled && {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
          },
        }),
        ...(githubEnabled && {
          github: {
            clientId: env.GITHUB_CLIENT_ID!,
            clientSecret: env.GITHUB_CLIENT_SECRET!,
          },
        }),
      }
    : undefined;

// ─── Plugins ─────────────────────────────────────────────────
//
// `basePlugins` are the platform-owned plugins (always present, gated on env).
// Module-contributed plugins are merged in at boot via `createAuth(extras)`.

/**
 * Better Auth plugin list type. Exported so modules can strongly type their
 * `betterAuthPlugins()` return value without going through the `unknown[]`
 * erasure at the `@appstrate/core` contract layer.
 */
export type BetterAuthPluginList = NonNullable<Parameters<typeof betterAuth>[0]["plugins"]>;

// Note: NO type annotation on `basePlugins` — TypeScript infers the specific
// plugin types (e.g. magicLink's `signInMagicLink` method), which flow through
// to `buildAuth()` so consumers retain typed access to plugin-contributed API.
const basePlugins = [
  ...(smtpEnabled
    ? [
        magicLink({
          disableSignUp: true,
          expiresIn: 7 * 24 * 60 * 60, // 7 days — matches invitation expiry
          allowedAttempts: 5, // Browsers may hit verify multiple times (prefetch, preconnect)
          sendMagicLink: async ({ email, url }) => {
            try {
              const normalizedEmail = email.toLowerCase().trim();

              // Parse callbackURL from the magic link to determine context
              const callbackURL = new URL(url).searchParams.get("callbackURL") ?? "";
              const isInvitation = callbackURL.startsWith("/invite/");

              let subject: string;
              let html: string;

              if (isInvitation) {
                // Extract invitation token from callbackURL: /invite/{token}/accept
                const invitationToken = callbackURL.split("/")[2];
                const [invitation] = invitationToken
                  ? await db
                      .select({
                        orgId: orgInvitations.orgId,
                        role: orgInvitations.role,
                        invitedBy: orgInvitations.invitedBy,
                      })
                      .from(orgInvitations)
                      .where(eq(orgInvitations.token, invitationToken))
                      .limit(1)
                  : [];

                if (invitation) {
                  const [orgRow, inviterRow] = await Promise.all([
                    db
                      .select({ name: organizations.name })
                      .from(organizations)
                      .where(eq(organizations.id, invitation.orgId))
                      .limit(1)
                      .then(([r]) => r),
                    invitation.invitedBy
                      ? db
                          .select({ displayName: profiles.displayName, name: user.name })
                          .from(user)
                          .leftJoin(profiles, eq(profiles.id, user.id))
                          .where(eq(user.id, invitation.invitedBy))
                          .limit(1)
                          .then(([r]) => r)
                      : null,
                  ]);

                  ({ subject, html } = renderEmail("invitation", {
                    email: normalizedEmail,
                    inviteUrl: url,
                    orgName: orgRow?.name ?? "Organisation",
                    inviterName: inviterRow?.displayName || inviterRow?.name || "Un membre",
                    role: invitation.role,
                    locale: "fr",
                  }));
                } else {
                  // Invitation token not found — fall back to generic
                  ({ subject, html } = renderEmail("magic-link", {
                    email: normalizedEmail,
                    url,
                    locale: "fr",
                  }));
                }
              } else {
                // Generic magic link sign-in email
                ({ subject, html } = renderEmail("magic-link", {
                  email: normalizedEmail,
                  url,
                  locale: "fr",
                }));
              }

              await smtpTransport!.sendMail({
                from: env.SMTP_FROM,
                to: email,
                subject,
                html,
              });
            } catch {
              // Fire-and-forget
            }
          },
        }),
      ]
    : []),
];

// ─── Auth — lazy factory ──────────────────────────────────
//
// The Better Auth instance is constructed lazily by `createAuth()` during
// boot, AFTER modules have registered their plugin contributions via
// `AppstrateModule.betterAuthPlugins()` (and companion Drizzle tables via
// `AppstrateModule.drizzleSchemas()`). All consumers must call `getAuth()`
// at request time / post-boot — never at module-evaluation time.
//
// Test harness: `test/setup/preload.ts` calls `createAuth([], {})` during
// preload so module test runs boot cleanly.

function buildAuth(
  extraPlugins: BetterAuthPluginList = [],
  extraSchemas: Record<string, unknown> = {},
) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { ...schema, ...extraSchemas },
    }),

    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,

    plugins: [...basePlugins, ...extraPlugins],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: smtpEnabled,
      ...(smtpEnabled && {
        sendResetPassword: async ({ user, url }) => {
          try {
            const { subject, html } = renderEmail("reset-password", {
              email: user.email,
              url,
              locale: "fr",
            });
            await smtpTransport!.sendMail({
              from: env.SMTP_FROM,
              to: user.email,
              subject,
              html,
            });
          } catch {
            // Fire-and-forget — don't block reset flow if email fails
          }
        },
      }),
    },

    ...(smtpEnabled && {
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
          try {
            const { subject, html } = renderEmail("verification", {
              user,
              url,
              locale: "fr",
            });
            await smtpTransport!.sendMail({
              from: env.SMTP_FROM,
              to: user.email,
              subject,
              html,
            });
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
          ...(googleEnabled ? ["google" as const] : []),
          ...(githubEnabled ? ["github" as const] : []),
        ],
        allowDifferentEmails: true,
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Refresh every 24h
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },

    user: {
      additionalFields: {},
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: !smtpEnabled,
      },
    },

    trustedOrigins: env.TRUSTED_ORIGINS,

    ...(env.COOKIE_DOMAIN
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: env.COOKIE_DOMAIN,
            },
          },
        }
      : {}),

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (_beforeSignupHook) {
              await _beforeSignupHook(user.email);
            }
          },
          after: async (user) => {
            await db.insert(profiles).values({
              id: user.id,
              displayName: user.name || user.email,
              language: "fr",
            });
          },
        },
      },
    },
  });
}

// ─── Factory + lazy singleton ────────────────────────────

type AuthInstance = ReturnType<typeof buildAuth>;

let _auth: AuthInstance | null = null;

/**
 * Construct the Better Auth singleton. Idempotent — subsequent calls are
 * no-ops. Must be called once during boot, after modules have loaded, so
 * that any plugins contributed via `AppstrateModule.betterAuthPlugins()`
 * (and their companion Drizzle tables via
 * `AppstrateModule.drizzleSchemas()`) are merged with `basePlugins` and the
 * core schema before the instance is built.
 */
export function createAuth(
  extraPlugins: BetterAuthPluginList = [],
  extraSchemas: Record<string, unknown> = {},
): void {
  if (_auth) return;
  _auth = buildAuth(extraPlugins, extraSchemas);
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
