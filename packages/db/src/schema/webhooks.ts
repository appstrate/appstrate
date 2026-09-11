// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.ts";
import { spaces } from "./spaces.ts";
import { packages } from "./packages.ts";

// Webhooks tables — centralized into the core schema (formerly owned by the
// webhooks module). The system migration pipeline (`applyCoreMigrations`)
// creates them at boot; they exist regardless of whether the webhooks module
// is loaded in `MODULES`. Behavior (routes, delivery worker, RBAC) stays in
// `apps/api/src/modules/webhooks`.

// Webhooks are polymorphic across scoping level, mirroring the OIDC
// `oauth_clients` model:
//
//   - `level: "org"` — the webhook subscribes to events from any space
//     in the org. `spaceId` is NULL.
//   - `level: "space"` — the webhook subscribes to events from a single
//     space pinned at creation. `spaceId` is NOT NULL.
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(), // wh_ prefix
    level: text("level").notNull().$type<"org" | "space">(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: text("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    url: text("url").notNull(),
    events: text("events").array().notNull(), // ["run.success", "run.failed"]
    packageId: text("package_id").references(() => packages.id, { onDelete: "set null" }), // null = all packages
    payloadMode: text("payload_mode").notNull().default("full"), // "full" | "summary"
    enabled: boolean("enabled").notNull().default(true),
    secret: text("secret").notNull(), // whsec_ prefix, plaintext (needed for HMAC signing)
    // Dual-signature rotation window. When `secretNext` is non-null and
    // `secretNextExpiresAt` is in the future, every outbound delivery is
    // signed with BOTH secrets in a space-separated `webhook-signature`
    // header (Standard Webhooks multi-signature spec). Once the deadline
    // passes, the delivery worker promotes `secret_next` → `secret` and
    // clears these columns inline. Null on both = no rotation in flight.
    secretNext: text("secret_next"),
    secretNextExpiresAt: timestamp("secret_next_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_webhooks_org_id").on(table.orgId),
    index("idx_webhooks_space_enabled").on(table.spaceId, table.enabled),
    // Preserved verbatim from the module's raw-SQL migration (0000_initial.sql).
    check("webhooks_level_values", sql`level IN ('org', 'space')`),
    check(
      "webhooks_level_check",
      sql`(level = 'org' AND space_id IS NULL) OR (level = 'space' AND space_id IS NOT NULL)`,
    ),
    // Closed vocabulary (migration 0051). The routes validate the INPUT with
    // `z.enum(["full", "summary"])` and then narrow the OUTPUT again on the way
    // back out — a defensive read is the tell that the column could not promise
    // what the write already required.
    check("webhooks_payload_mode_valid", sql`payload_mode IN ('full', 'summary')`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(), // evt_ prefix
    eventType: text("event_type").notNull(), // "run.success" etc.
    status: text("status").notNull().default("pending"), // "pending" | "success" | "failed"
    statusCode: integer("status_code"), // HTTP response code
    latency: integer("latency"), // ms
    attempt: integer("attempt").notNull().default(1),
    error: text("error"), // error message if failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_webhook_deliveries_webhook_id").on(table.webhookId),
    // Closed vocabulary (migration 0051). One worker writes all three values;
    // the reader used to cast (`row.status as …`) rather than check.
    check("webhook_deliveries_status_valid", sql`status IN ('pending', 'success', 'failed')`),
  ],
);
