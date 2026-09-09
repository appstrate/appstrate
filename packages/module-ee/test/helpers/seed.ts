// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Seed factories for EE module tests.
 *
 * Each function inserts a row into the corresponding EE table
 * and returns the inserted record. Required fields must be provided;
 * optional fields have sensible defaults.
 */
import { getEeDb } from "../../src/db.ts";
import {
  billingAccounts,
  orgUsageRecords,
  freeTierClaims,
  eeBilledLlmUsage,
  billingCursor,
  billingManagers,
} from "../../drizzle/schema.ts";
import type { LlmUsageLedgerRow } from "@appstrate/core/module";
import { mockLedger } from "./mock-platform.ts";

export async function seedBillingAccount(overrides: {
  orgId: string;
  planId?: string;
  creditsUsed?: number;
  creditQuota?: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  cancelAtPeriodEnd?: boolean;
  periodEnd?: Date | null;
  billingEmail?: string | null;
  billingCc?: string[];
  /** Non-null models an org deletion whose Stripe cancellation is unconfirmed. */
  cancelRequestedAt?: Date | null;
}) {
  const db = getEeDb();
  const [account] = await db
    .insert(billingAccounts)
    .values({
      orgId: overrides.orgId,
      planId: overrides.planId ?? "free",
      creditsUsed: overrides.creditsUsed ?? 0,
      creditQuota: overrides.creditQuota ?? 5000,
      stripeCustomerId: overrides.stripeCustomerId ?? null,
      stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
      subscriptionStatus: overrides.subscriptionStatus ?? null,
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      periodEnd: overrides.periodEnd ?? null,
      billingEmail: overrides.billingEmail ?? null,
      billingCc: overrides.billingCc ?? [],
      cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    })
    .returning();
  return account!;
}

export async function seedUsageRecord(overrides: {
  orgId: string;
  contextType?: string;
  contextId: string;
  costCredits: number;
}) {
  const db = getEeDb();
  const [record] = await db
    .insert(orgUsageRecords)
    .values({
      orgId: overrides.orgId,
      contextType: overrides.contextType ?? "run",
      contextId: overrides.contextId,
      costCredits: overrides.costCredits,
    })
    .returning();
  return record!;
}

export async function seedFreeTierClaim(overrides: { email: string }) {
  const db = getEeDb();
  const [claim] = await db
    .insert(freeTierClaims)
    .values({
      email: overrides.email,
    })
    .returning();
  return claim!;
}

let _llmUsageIdSeq = 1;

/** Reset the synthetic `llm_usage.id` sequence between test files/cases. */
export function resetLlmUsageIdSeq(): void {
  _llmUsageIdSeq = 1;
}

/**
 * Append a ledger row the platform would return via the mock
 * `PlatformServices.usage.list`. EE reads the ledger through that cursor —
 * never from its own DB — so tests populate the mock, not a table. Returns the
 * synthetic `llm_usage.id` so tests can assert the resulting billing marker in
 * `ee_billed_llm_usage`.
 *
 * Defaults model the common case: a settled, platform-provided ("system") agent
 * run row. Tests override `settled`, `credentialSource`, `contextType`, etc. to
 * drive the frontier / non-billable paths.
 */
export function seedLlmUsage(overrides: {
  orgId: string;
  costUsd: number;
  id?: number;
  source?: "runner" | "proxy";
  contextType?: "run" | "chat" | null;
  contextId?: string | null;
  credentialSource?: "system" | "org" | null;
  settled?: boolean;
  /**
   * How much of `costUsd` the platform could price. Omitted defaults to
   * `"priced"` (the common case); pass `null` explicitly for a row that predates
   * the field, which the billing rules must NOT read as priced.
   */
  pricingStatus?: "priced" | "partial" | "unpriced" | null;
}): number {
  const id = overrides.id ?? _llmUsageIdSeq++;
  const contextType = overrides.contextType === undefined ? "run" : overrides.contextType;
  const contextId =
    overrides.contextId === undefined
      ? contextType === null
        ? null
        : `ctx-${id}`
      : overrides.contextId;
  const row: LlmUsageLedgerRow = {
    id,
    orgId: overrides.orgId,
    costUsd: overrides.costUsd,
    source: overrides.source ?? "runner",
    contextType,
    contextId,
    credentialSource:
      overrides.credentialSource === undefined ? "system" : overrides.credentialSource,
    pricingStatus: overrides.pricingStatus === undefined ? "priced" : overrides.pricingStatus,
    settled: overrides.settled ?? true,
  };
  mockLedger.push(row);
  return id;
}

/**
 * Insert a billing marker into the EE-owned `ee_billed_llm_usage`,
 * simulating a past sweep that already claimed the ledger row. Used by tests
 * that need a pre-billed row (double-sweep idempotency).
 */
export async function markLlmUsageBilled(args: {
  llmUsageId: number;
  billedAt?: Date;
}): Promise<void> {
  const db = getEeDb();
  await db.insert(eeBilledLlmUsage).values({
    llmUsageId: args.llmUsageId,
    billedAt: args.billedAt ?? new Date(),
  });
}

/**
 * Seed the singleton billing cursor at a given watermark. `floorId` defaults to
 * 0 — the column's own default, i.e. a cursor that predates the cutover floor —
 * so a test that cares about the exclusion bound has to state it.
 */
export async function seedBillingCursor(lastLlmUsageId: number, floorId = 0): Promise<void> {
  const db = getEeDb();
  await db
    .insert(billingCursor)
    .values({ id: true, lastLlmUsageId, floorId })
    .onConflictDoUpdate({ target: billingCursor.id, set: { lastLlmUsageId, floorId } });
}

/** Grant `billing:*` to a user through the EE-owned billing-manager table. */
export async function seedBillingManager(overrides: {
  orgId: string;
  userId: string;
  addedBy?: string;
}) {
  const db = getEeDb();
  const [row] = await db
    .insert(billingManagers)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      addedBy: overrides.addedBy ?? "user-owner",
    })
    .returning();
  return row!;
}
