import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createTransport } from "nodemailer";
import { renderEmail } from "@appstrate/emails";
import { db } from "./client.ts";
import * as schema from "./schema.ts";
import { profiles } from "./schema.ts";
import { getEnv } from "@appstrate/env";

const env = getEnv();

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

// ─── Auth ──────────────────────────────────────────────────

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),

  baseURL: env.APP_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: smtpEnabled,
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
        after: async (user) => {
          await db.insert(profiles).values({
            id: user.id,
            displayName: user.name || user.email,
          });
        },
      },
    },
  },
});
