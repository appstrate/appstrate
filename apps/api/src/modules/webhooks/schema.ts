// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, boolean, integer, uuid, index } from "drizzle-orm/pg-core";
import { organizations, applications, packages } from "@appstrate/db/schema";

// Webhooks module — owns the webhooks and webhook_deliveries tables.
//
// FKs to core tables are declared via Drizzle `.references()` so the schema
// is self-documenting and usable with Drizzle's query builder. Core tables
// always exist before the module runs (core migrations run first at boot).
// For the reverse direction (core → module), raw SQL in the module migration
// is used instead (see scheduling module for an example).

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(), // wh_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: text("events").array().notNull(), // ["run.success", "run.failed"]
    packageId: text("package_id").references(() => packages.id, { onDelete: "set null" }), // null = all packages
    payloadMode: text("payload_mode").notNull().default("full"), // "full" | "summary"
    enabled: boolean("enabled").notNull().default(true),
    secret: text("secret").notNull(), // whsec_ prefix, plaintext (needed for HMAC signing)
    previousSecret: text("previous_secret"), // for rotation grace period
    previousSecretExpiresAt: timestamp("previous_secret_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_webhooks_org_id").on(table.orgId),
    index("idx_webhooks_application_id").on(table.applicationId),
    index("idx_webhooks_app_enabled").on(table.applicationId, table.enabled),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_webhook_deliveries_webhook_id").on(table.webhookId),
    index("idx_webhook_deliveries_event_id").on(table.eventId),
    index("idx_webhook_deliveries_status").on(table.webhookId, table.status),
  ],
);
