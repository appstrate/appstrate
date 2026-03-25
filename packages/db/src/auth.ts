import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createTransport } from "nodemailer";
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

// ─── Google social provider (only if configured) ───────────

const googleEnabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const socialProviders = googleEnabled
  ? {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      },
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
        void smtpTransport!.sendMail({
          from: env.SMTP_FROM,
          to: user.email,
          subject: "Vérifiez votre adresse email",
          html: `<p>Cliquez sur le lien pour vérifier votre email :</p><p><a href="${url}">${url}</a></p>`,
        });
      },
    },
  }),

  socialProviders,

  account: {
    accountLinking: {
      enabled: googleEnabled,
      trustedProviders: googleEnabled ? ["google"] : [],
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
