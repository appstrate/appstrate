// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// All EE tables are prefixed with "ee_" to avoid collisions with OSS tables.
// EE migrations NEVER modify OSS tables — they only create/alter ee_* tables
// and add FK references to OSS tables via raw SQL.

export const billingAccounts = pgTable(
  "ee_billing_accounts",
  {
    orgId: uuid("org_id").primaryKey(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    planId: text("plan_id").default("free").notNull(),
    creditsUsed: integer("credits_used").default(0).notNull(),
    creditQuota: integer("credit_quota").default(0).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    // Cached Stripe subscription status — null for free/no-subscription orgs
    subscriptionStatus: text("subscription_status"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    /**
     * Billing contact — where invoices, receipts and payment alerts go, and the
     * `email` set on the Stripe customer. NULL means "fall back to the org's
     * owners", which is a live fallback rather than a default: an org whose
     * owner changes keeps reaching a real person without a write here.
     */
    billingEmail: text("billing_email"),
    /**
     * Additional recipients copied on every billing email. Capped at 5 at the
     * route, not in the schema: the cap is a product decision that may move,
     * and a CHECK on an array column costs a migration to change.
     */
    billingCc: text("billing_cc")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_ee_billing_stripe_customer").on(table.stripeCustomerId),
    uniqueIndex("idx_ee_billing_stripe_subscription").on(table.stripeSubscriptionId),
  ],
);

/**
 * Per-usage-context audit row (integer credits). Keyed generically by
 * `(context_type, context_id)` — an agent run (`run` / run id), a chat session
 * (`chat` / session id), or the org's durable fallback bucket
 * (`unattributed` / org id) — so the billing sweep can attribute every debit.
 * The unique index on the pair is the idempotency arbiter for the sweep's
 * `ON CONFLICT DO UPDATE` accumulation (a context billed across multiple sweep
 * passes accumulates into one row). Both columns are therefore NOT NULL.
 *
 * `cost_usd` is the cumulative raw dollar total attributed to this context.
 * Credits are money, so the sweep bills the DELTA between the credits implied by
 * the new cumulative `cost_usd` and the previously debited `cost_credits`
 * (`dollarsToCredits(cost_usd) − cost_credits`). Keeping the raw dollars means a
 * context whose cheap rows straddle several sweep passes carries its sub-credit
 * remainder forward instead of flooring to 0 each pass — nothing is dropped.
 *
 * `cost_usd` is `numeric`, NOT `double precision`. Two reasons, both about the
 * `unattributed` bucket — one row per org that accumulates forever:
 *   1. the accumulation `cost_usd = cost_usd + delta` is exact in decimal, so
 *      the running total does not drift as the row grows without bound;
 *   2. the sweep's `RETURNING` reconstructs the pre-pass cumulative as
 *      `cost_usd - delta` to compute the credit delta. Under binary floating
 *      point that subtraction is not exact, so the reconstructed value could
 *      round to a different credit than the one actually debited. Under
 *      `numeric` it recovers the pre-update value exactly.
 * Drizzle maps `numeric` to a decimal STRING in TS (no `mode` option at
 * drizzle-orm 0.39) — deliberate: the value never round-trips through a JS
 * float. Callers that need a number convert explicitly.
 */
export const orgUsageRecords = pgTable(
  "ee_usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    contextType: text("context_type").notNull(),
    contextId: text("context_id").notNull(),
    costCredits: integer("cost_credits").notNull(),
    /** Cumulative raw dollar total for this context — the delta-billing basis. */
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }).default("0").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_ee_usage_records_context").on(table.contextType, table.contextId),
    index("idx_ee_usage_records_org_id").on(table.orgId),
    index("idx_ee_usage_records_created_at").on(table.createdAt),
  ],
);

export const stripeEvents = pgTable("ee_stripe_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  status: text("status", { enum: ["processing", "done"] })
    .default("processing")
    .notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/**
 * Side-car table tracking which `llm_usage` rows have been billed.
 *
 * The platform-owned `llm_usage` table is the canonical LLM-call ledger
 * (per-call cost, attribution, credential source). Billing is an EE-only
 * concern, so the "this row has been debited" marker lives here instead of as a
 * column on `llm_usage` — that would leak a billing concept into the OSS schema.
 *
 * Contract:
 *   - `llmUsageId` — PRIMARY KEY, type `integer` to match the OSS
 *     `llm_usage.id` column (declared `serial`, i.e. `INTEGER`). Cross-
 *     table FKs are intentionally avoided: EE schemas never
 *     `.references()` platform-owned tables (no ownership inversion).
 *     The primary key gives us idempotent inserts via
 *     `ON CONFLICT (llm_usage_id) DO NOTHING` — the claim that lets the
 *     cursor sweep re-read already-processed rows safely.
 *
 * Lifecycle: rows are inserted by the billing sweep and never deleted. One
 * `(integer, timestamptz)` row per billed ledger row is small enough that
 * unbounded growth is not a concern at any plausible scale.
 */
export const eeBilledLlmUsage = pgTable("ee_billed_llm_usage", {
  llmUsageId: integer("llm_usage_id").primaryKey(),
  billedAt: timestamp("billed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const freeTierClaims = pgTable("ee_free_tier_claims", {
  email: text("email").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Single-row watermark for the cursor-based billing sweep. EE consumes the
 * platform's append-only `llm_usage` ledger by serial `id`: `last_llm_usage_id`
 * is the highest ledger id already processed. The sweep reads
 * `usage.list({ afterId: last_llm_usage_id })`, bills the settled frontier, and
 * advances the watermark in the SAME transaction as the debits — so a crash
 * mid-pass rolls both back and the next pass retries from the last committed id.
 *
 * The boolean `id` PK + `CHECK (id)` pins the table to exactly one row (id is
 * always `true`): the watermark is a singleton, not a per-org cursor.
 *
 * MONOTONIC: every code path advances it with `GREATEST(...)`, so two
 * overlapping sweepers can never rewind it. Operator SQL is deliberately NOT
 * fenced off — re-seeding the watermark is a documented recovery action, and
 * the claim table (`ee_billed_llm_usage`, never purged) makes a re-read of
 * already-billed rows a no-op anyway.
 */
export const billingCursor = pgTable(
  "ee_billing_cursor",
  {
    id: boolean("id").primaryKey().default(true),
    lastLlmUsageId: integer("last_llm_usage_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check("ee_billing_cursor_single_row", sql`${table.id}`)],
);

/**
 * Billing managers — org users who may act on billing without being org admins
 * (RBAC spec §10). EE grants them `billing:read` + `billing:manage` through
 * the module's `principalPermissions` surface, so the grant attaches to a
 * PRINCIPAL instead of to an org role: `billing` is EE vocabulary and core's
 * `org_role` enum is Apache-2.0, which is exactly the coupling that surface
 * exists to avoid.
 *
 * `user_id` / `added_by` are `text`, matching the platform's `user.id` (Better
 * Auth ids are text, not uuid); `org_id` is `uuid` like every other EE
 * table. As everywhere in EE, there is no FK to a platform-owned table —
 * EE runs its own database. Consequence: a row can outlive the user it
 * names. That is harmless because the resolver only ever answers "is THIS
 * caller a manager", and a caller the platform no longer authenticates never
 * reaches it.
 */
export const billingManagers = pgTable(
  "ee_billing_managers",
  {
    orgId: uuid("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Who granted it — the audit trail for a permission grant made outside RBAC. */
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // No secondary index: the composite PK `(org_id, user_id)` serves the
  // resolver's point lookup AND, through its leading column, every org-scoped
  // read and delete this table takes.
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
);
