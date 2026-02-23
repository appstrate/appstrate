import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./client.ts";
import * as schema from "./schema.ts";
import { profiles } from "./schema.ts";
import { getEnv } from "@appstrate/env";

const env = getEnv();

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

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;
