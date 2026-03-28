import { pgTable, text, timestamp, boolean, integer, uuid, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.ts";
import { applications } from "./applications.ts";

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(), // wh_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("application"), // "organization" | "application"
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    url: text("url").notNull(),
    events: text("events").array().notNull(), // ["execution.completed", "execution.failed"]
    packageId: text("flow_id"), // null = all packages (column kept as flow_id for existing migrations)
    payloadMode: text("payload_mode").notNull().default("full"), // "full" | "summary"
    active: boolean("active").notNull().default(true),
    secret: text("secret").notNull(), // whsec_ prefix, plaintext (needed for HMAC signing)
    previousSecret: text("previous_secret"), // for rotation grace period
    previousSecretExpiresAt: timestamp("previous_secret_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_webhooks_org_id").on(table.orgId),
    index("idx_webhooks_scope_org").on(table.scope, table.orgId, table.active),
    index("idx_webhooks_application_id").on(table.applicationId),
    index("idx_webhooks_app_active").on(table.applicationId, table.active),
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
    eventType: text("event_type").notNull(), // "execution.completed" etc.
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
