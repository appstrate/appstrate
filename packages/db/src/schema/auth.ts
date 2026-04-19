// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * `realm` discriminates audiences sharing the Better Auth `user` table.
 *
 *   - `"platform"` — operator of the Appstrate platform itself (admins,
 *     org members, dashboard users). Default for any signup outside an
 *     OIDC end-user flow.
 *   - `"end_user:<applicationId>"` — end-user of a third-party application
 *     using Appstrate as its OIDC IdP at `level=application`. Assigned by
 *     the OIDC module's realm resolver when the `oidc_pending_client`
 *     cookie points to an application-level OAuth client at BA user
 *     creation time.
 *
 * The realm guards prevent audience collision: a session minted via the
 * OIDC end-user flow cannot be replayed against platform routes, and an
 * end-user session for app A cannot be replayed against app B's
 * `/authorize`. Without this, the single-user-pool made any BA session
 * interchangeable across audiences — a dashboard fixture for OIDC
 * end-users by construction.
 */
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    realm: text("realm").notNull().default("platform"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("user_realm_idx").on(t.realm)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Denormalized copy of `user.realm` captured at session-create time so
    // the request-time realm guard in the auth pipeline can reject mismatched
    // audiences without a user-table join on every request.
    realm: text("realm").notNull().default("platform"),
  },
  (t) => [index("session_realm_idx").on(t.realm)],
);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
