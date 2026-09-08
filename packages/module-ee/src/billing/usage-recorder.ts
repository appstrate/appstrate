// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getEeDb, type EeDb, type EeTx } from "../db.ts";
import {
  billingAccounts,
  orgUsageRecords,
  eeBilledLlmUsage,
  billingCursor,
} from "../../drizzle/schema.ts";
import { eq, sql, type SQL } from "drizzle-orm";
import type { LlmUsageLedgerRow, PlatformServices } from "@appstrate/core/module";
import { logger } from "../logger.ts";
import { getPlatformServices } from "../platform.ts";
import { getEeEnv } from "../env.ts";
import { dollarsToCredits, CREDITS_PER_DOLLAR } from "../credits.ts";
import { sendBillingEmail } from "../emails/send.ts";
import { getPlans } from "../config.ts";

/** Threshold at which we send a quota warning email (80%) */
const QUOTA_WARNING_THRESHOLD = 0.8;

/**
 * The platform's `usage.list` hard ceiling (`LLM_USAGE_LIST_MAX_LIMIT`). A read
 * asking for more is capped server-side, so the sweep clamps here explicitly
 * rather than requesting a limit it will not get.
 */
const LEDGER_LIST_MAX_LIMIT = 1000;

/**
 * Decimal places of `ee_usage_records.cost_usd` (`numeric(24,12)`). Every
 * dollar amount is bound as a decimal STRING at exactly this scale, so
 * `stored + delta` and `stored - delta` are both exact in Postgres `numeric`
 * arithmetic — the pre-pass cumulative reconstructed by the `RETURNING`
 * expression is then bit-for-bit the value that was there before the update.
 * Amounts below 1e-12 USD cannot be represented by the column at all, so
 * rounding the bound parameter to the same scale loses nothing extra.
 */
const USD_SCALE = 12;

/** Bind a dollar amount as an exact `numeric` operand at the column's scale. */
function usd(dollars: number): SQL {
  return sql`${dollars.toFixed(USD_SCALE)}::numeric`;
}

/**
 * Optional test seam for {@link sweepLedgerBatch}. `onBeforeCommit` runs INSIDE
 * the sweep transaction, after the claims/debits/watermark advance but before it
 * commits, so a thrown error rolls the whole pass back. Production never passes it.
 */
export interface SweepHooks {
  onBeforeCommit?: () => Promise<void>;
}

/** Outcome of one cursor sweep pass, for logging + tests. */
export interface SweepResult {
  /**
   * Ledger rows the watermark advanced over this pass (the processed frontier):
   * the leading settled rows plus any unsettled NON-system rows skipped past.
   */
  processed: number;
  /**
   * Rows this pass newly claimed (billed) into `ee_billed_llm_usage`, from
   * BOTH the forward batch and the replay window. Always ≥ {@link replayBilled}.
   */
  billed: number;
  /**
   * Settled `system` rows ABOVE the previous watermark that an earlier pass had
   * already claimed. Steady state is 0 — rows above the watermark have by
   * definition never been read before, so a non-zero value still means a
   * re-seeded cursor or two overlapping sweepers. Deliberately EXCLUDES the
   * replay window, where re-reading claimed rows is the designed behavior and
   * would otherwise fire this signal on every single tick.
   */
  alreadyBilled: number;
  /**
   * Ledger rows this pass re-read from BELOW the watermark (the replay window).
   * Non-zero is the normal, healthy state: it proves the window is being
   * scanned. Zero on a non-empty ledger means replay is disabled or the cursor
   * is still within `REPLAY_WINDOW` of 0.
   */
  replayed: number;
  /**
   * Of {@link replayed}, the rows that were NOT already claimed — i.e. billed
   * for the FIRST time from below the watermark.
   *
   * This is the money counter. A serial id is assigned at INSERT but visible at
   * COMMIT, so a row can commit below an already-advanced watermark; without the
   * replay window such a row is invisible to `WHERE id > watermark` forever and
   * is lost in silence. Any non-zero value here is that loss being CAUGHT, and
   * is direct evidence the race is live in this deployment.
   */
  replayBilled: number;
  /**
   * Orgs whose usage this pass recorded but could NOT debit because they have no
   * `ee_billing_accounts` row. Their debt is durable in `ee_usage_records`;
   * see {@link OrphanedOrgDebt}.
   */
  orphanedOrgs: number;
  /** Watermark value the pass started from. */
  cursorFrom: number;
  /**
   * Watermark value the pass committed (== cursorFrom when nothing advanced).
   * Never below `cursorFrom`: the replay window is a READ offset only, and the
   * committed advance is `GREATEST`-guarded, so a frontier that ends inside the
   * replay region leaves the watermark exactly where it was.
   */
  cursorTo: number;
  /**
   * When the pass could not advance because the first row it may not pass is an
   * unsettled `system` row (a wedged run stalling the global cursor), the id of
   * that blocking row; `null` when the pass made progress or the ledger was
   * drained. Drives the sweeper's head-of-line stall observability.
   *
   * MAY BE BELOW {@link cursorFrom}, which was structurally impossible before
   * the replay window: a row that commits under an already-advanced watermark is
   * now read again, and if it is an unsettled `system` row it stalls the frontier
   * from underneath. That is INTENDED, and it is what makes the no-loss
   * guarantee hold — the stall pins the watermark, so the row cannot drift out
   * of the replay window while its run finishes. The two cases need different
   * diagnoses, so the sweeper reports which one it is; see
   * `stalledBelowWatermark` in `billing-sweeper.ts`.
   */
  stalledOnId: number | null;
}

/** Outcome of {@link ensureCursorSeeded}. */
export interface CursorSeedResult {
  /** True when THIS call inserted the cutover watermark (cursor was absent). */
  seeded: boolean;
  /** The cursor's current watermark after the call. */
  lastLlmUsageId: number;
}

/**
 * Ensure the singleton billing cursor exists, seeding it at cutover.
 *
 * On the first boot after migration 0001 creates an empty `ee_billing_cursor`,
 * the watermark must be initialized to the platform's settled frontier
 * (`usage.settledFrontier()` — the highest id below which every row is settled)
 * so the sweep bills nothing retroactively yet strands no in-flight runner row.
 * Seeding a plain `MAX(id)` would jump past an in-flight row already holding a
 * low id and lose its revenue; the settled frontier stops before the first
 * unsettled row.
 *
 * This is called from TWO places, sharing one implementation:
 *   - The module's `init()`, synchronously at boot BEFORE the server takes
 *     traffic. This closes the cutover loss window: without it the cursor was
 *     only seeded at the FIRST SWEEP TICK (~5 min after boot), at the frontier
 *     of THAT moment, so every billable row recorded between boot and the first
 *     tick fell below the initial watermark and was never billed.
 *   - `sweepLedgerBatch`, as a safety-net fallback if a pass ever finds the
 *     cursor still absent (e.g. init's seed did not run).
 *
 * Idempotent and race-safe: the insert is `ON CONFLICT (id) DO NOTHING`, so a
 * second instance seeding concurrently is a no-op and an existing watermark is
 * never rewound. `seeded` reflects whether the cursor was absent when this call
 * read it (a cutover for this caller); the watermark is re-read after the insert
 * so a race-losing caller still returns the winner's value.
 */
export async function ensureCursorSeeded(
  services: PlatformServices,
  db: EeDb,
): Promise<CursorSeedResult> {
  const [existing] = await db
    .select({ lastLlmUsageId: billingCursor.lastLlmUsageId })
    .from(billingCursor)
    .where(eq(billingCursor.id, true));
  if (existing) return { seeded: false, lastLlmUsageId: existing.lastLlmUsageId };

  const frontierId = await services.usage.settledFrontier();
  await db
    .insert(billingCursor)
    .values({ id: true, lastLlmUsageId: frontierId })
    .onConflictDoNothing({ target: billingCursor.id });
  logger.info("billing cursor initialized at cutover", { lastLlmUsageId: frontierId });

  // Re-read the authoritative watermark: under a concurrent seed race, a losing
  // `ON CONFLICT DO NOTHING` keeps the winner's value, which may differ.
  const [row] = await db
    .select({ lastLlmUsageId: billingCursor.lastLlmUsageId })
    .from(billingCursor)
    .where(eq(billingCursor.id, true));
  return { seeded: true, lastLlmUsageId: row!.lastLlmUsageId };
}

/** Per-account post-commit state, used to fire the quota-warning email. */
export interface AccountDebit {
  orgId: string;
  deltaCredits: number;
  creditsUsed: number;
  creditQuota: number;
  planId: string;
}

/**
 * An org whose usage was recorded but could not be debited: it has billable
 * ledger rows and NO `ee_billing_accounts` row.
 *
 * This is reachable in production: `onOrgDelete` removes the billing account
 * immediately, but the platform REFUSES to delete an organization while a run
 * is active — so an org can outlive its account. Anything it spends afterwards
 * lands here.
 *
 * Treatment (see {@link billLedgerRows}): the org is ISOLATED, never fatal. Its
 * rows are still claimed and its `ee_usage_records` still accumulate — so the
 * exact debt is durable and auditable — but no account is debited and the pass
 * commits normally, so no other tenant's billing is held hostage. Repair with
 * `bun run repair:account -- <orgId> <ownerEmail>`, which re-provisions the
 * account and applies the recorded debt.
 */
export interface OrphanedOrgDebt {
  orgId: string;
  /** Credits this pass recorded for the org but could not debit. */
  deltaCredits: number;
}

/** What {@link billLedgerRows} did inside the caller's transaction. */
export interface BillOutcome {
  /** Rows newly claimed by this call. */
  billed: number;
  /**
   * The `llm_usage.id`s newly claimed by this call (`billed === billedIds.length`).
   * The sweep partitions these around its watermark to tell a normal forward
   * claim from one caught by the replay window; exposing the ids keeps that
   * split on the SINGLE claim statement instead of billing in two calls.
   */
  billedIds: number[];
  /** Rows an earlier pass had already claimed (idempotent re-read). */
  alreadyBilled: number;
  /** Successful per-org debits, for post-commit quota signals. */
  debits: AccountDebit[];
  /** Orgs with billable usage and no billing account — recorded, not debited. */
  orphans: OrphanedOrgDebt[];
}

/**
 * Claim + record + debit a set of ledger rows, INSIDE the caller's transaction.
 *
 * Shared by the periodic cursor sweep ({@link sweepLedgerBatch}) and the
 * final drain performed when an organization is deleted (`billing/org-drain.ts`).
 * Both need exactly the same money semantics; the only difference is which rows
 * they select and whether they move the global watermark.
 *
 * Only SETTLED, platform-provided (`credentialSource === "system"`) rows are
 * billable — callers pass an already-filtered set.
 *
 * Rounding contract: credits are money, so nothing is dropped. For each
 * (org, context) bucket the call adds its won dollars to the context's
 * cumulative `ee_usage_records.cost_usd` and bills the DELTA
 * `dollarsToCredits(new cost_usd) - previously-debited cost_credits` (never
 * negative, since cumulative dollars only grow). A context whose cheap rows
 * straddle several passes therefore carries its sub-credit remainder forward in
 * `cost_usd` instead of flooring to 0 each pass. The org debit is the sum of its
 * buckets' deltas, keeping `ee_billing_accounts` and `ee_usage_records`
 * consistent. A null usage-context (rare: a row with no run/chat attribution)
 * accumulates in the org's synthetic (`unattributed`, orgId) context, so it
 * obeys the exact same carry-forward rule and loses no remainder.
 */
export async function billLedgerRows(
  tx: EeTx,
  billableRows: LlmUsageLedgerRow[],
): Promise<BillOutcome> {
  if (billableRows.length === 0) {
    return { billed: 0, billedIds: [], alreadyBilled: 0, debits: [], orphans: [] };
  }

  // Claim the billable rows. `ON CONFLICT (llm_usage_id) DO NOTHING` skips rows
  // an earlier pass already claimed; `RETURNING` yields exactly this call's slice.
  const won = await tx
    .insert(eeBilledLlmUsage)
    .values(billableRows.map((r) => ({ llmUsageId: r.id })))
    .onConflictDoNothing()
    .returning({ llmUsageId: eeBilledLlmUsage.llmUsageId });

  const billedIds = won.map((w) => w.llmUsageId);
  const billed = won.length;
  const alreadyBilled = billableRows.length - won.length;

  const wonIds = new Set(billedIds);
  const wonRows = billableRows.filter((r) => wonIds.has(r.id));

  // Aggregate the won slice's DOLLARS per bucket. A row with a usage context
  // (run / chat) joins its context bucket. A null-context row joins one durable
  // per-org `unattributed` bucket instead of being converted directly per pass:
  // this carries sub-credit fractions across sweeps.
  const contextBuckets = new Map<
    string,
    { orgId: string; contextType: string; contextId: string; dollars: number }
  >();
  for (const r of wonRows) {
    const contextType =
      r.contextType !== null && r.contextId !== null ? r.contextType : "unattributed";
    const contextId = r.contextType !== null && r.contextId !== null ? r.contextId : r.orgId;
    const key = `${r.orgId} ${contextType} ${contextId}`;
    const existing = contextBuckets.get(key);
    if (existing) existing.dollars += r.costUsd;
    else contextBuckets.set(key, { orgId: r.orgId, contextType, contextId, dollars: r.costUsd });
  }

  // Per-org credit deltas accumulated across all buckets. The org debit is the
  // sum of its buckets' deltas, so accounts and usage_records stay consistent by
  // construction.
  const perOrg = new Map<string, number>();

  // Per-context: cumulative-dollar delta billing. Add this call's dollars to the
  // context's running `cost_usd` and bill the change in whole credits it implies:
  // `dollarsToCredits(new cost_usd) - previously-debited cost_credits`. RETURNING
  // computes that delta from the post-update row: the pre-pass cumulative is
  // `cost_usd - dollars`, so the delta is
  // `cost_credits - round((cost_usd - dollars) * CREDITS_PER_DOLLAR)`. On a fresh
  // insert `cost_usd - dollars = 0`, so the delta is just the new credits. The
  // ON CONFLICT accumulation is atomic, so concurrent passes touching the same
  // context sum correctly. Sub-credit remainders live on in `cost_usd`, so
  // nothing is dropped.
  //
  // EXACTNESS: `cost_usd` is `numeric(24,12)` and every dollar operand is bound
  // as a decimal string at that same scale (see {@link usd}), so both the
  // accumulation and the `cost_usd - dollars` reconstruction are exact decimal
  // arithmetic — the RETURNING delta is always the credit delta actually
  // debited, no matter how large the cumulative grows. (The durable per-org
  // `unattributed` bucket grows without bound, so a float column's absolute
  // error would grow with it.)
  //
  // ROUNDING INVARIANT: exactly ONE rounding rule — half away from zero — is
  // shared by `dollarsToCredits` in src/credits.ts (JS `Math.round`, which is
  // half-away-from-zero for the non-negative dollars we bill) and every `round()`
  // below. Postgres `round(double precision)` rounds half to EVEN and would
  // disagree on an exact half-credit cumulative ($0.0025 → 2.5 credits); every
  // `round()` here has `numeric` operands, selecting `round(numeric)`, which
  // rounds half away from zero and matches `Math.round`.
  for (const b of contextBuckets.values()) {
    const dollars = usd(b.dollars);
    const [row] = await tx
      .insert(orgUsageRecords)
      .values({
        orgId: b.orgId,
        contextType: b.contextType,
        contextId: b.contextId,
        costUsd: b.dollars.toFixed(USD_SCALE),
        costCredits: dollarsToCredits(b.dollars),
      })
      .onConflictDoUpdate({
        target: [orgUsageRecords.contextType, orgUsageRecords.contextId],
        set: {
          costUsd: sql`${orgUsageRecords.costUsd} + ${dollars}`,
          costCredits: sql`round((${orgUsageRecords.costUsd} + ${dollars}) * ${CREDITS_PER_DOLLAR})::int`,
        },
      })
      .returning({
        deltaCredits: sql<number>`${orgUsageRecords.costCredits} - round((${orgUsageRecords.costUsd} - ${dollars}) * ${CREDITS_PER_DOLLAR})::int`,
      });
    const deltaCredits = Number(row!.deltaCredits);
    if (deltaCredits > 0) perOrg.set(b.orgId, (perOrg.get(b.orgId) ?? 0) + deltaCredits);
    else if (deltaCredits < 0) {
      // Cumulative dollars only ever grow, so a negative delta is impossible by
      // construction: it means the invariant `cost_credits == round(cost_usd *
      // CREDITS_PER_DOLLAR)` was broken out of band (manual SQL, a partially
      // applied migration). Never credit it back silently — that would be free
      // money — but never hide it either.
      logger.error("negative credit delta discarded — usage record invariant broken", {
        orgId: b.orgId,
        contextType: b.contextType,
        contextId: b.contextId,
        deltaCredits,
      });
    }
  }

  // Atomic per-org debit.
  const debits: AccountDebit[] = [];
  const orphans: OrphanedOrgDebt[] = [];
  for (const [orgId, deltaCredits] of perOrg) {
    const [account] = await tx
      .update(billingAccounts)
      .set({
        creditsUsed: sql`${billingAccounts.creditsUsed} + ${deltaCredits}`,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId))
      .returning({
        creditsUsed: billingAccounts.creditsUsed,
        creditQuota: billingAccounts.creditQuota,
        planId: billingAccounts.planId,
      });
    if (!account) {
      // ISOLATE, never abort. Aborting here (the previous behavior) rolled back
      // the claims, the usage records AND the watermark advance of the whole
      // pass — so a single account-less org froze billing for the ENTIRE fleet
      // and every tick replayed the same doomed rows forever. The org's debt is
      // still fully durable in `ee_usage_records`; only the account debit is
      // impossible, because there is no account.
      orphans.push({ orgId, deltaCredits });
      continue;
    }
    debits.push({ orgId, deltaCredits, ...account });
  }

  return { billed, billedIds, alreadyBilled, debits, orphans };
}

/**
 * A pass that billed nothing and advanced nothing (or only seeded the cursor).
 * Factored out so the four early exits of {@link sweepLedgerBatch} cannot drift
 * from the result shape.
 */
function noProgress(args: {
  cursorFrom: number;
  cursorTo: number;
  stalledOnId?: number | null;
  replayed?: number;
}): SweepResult {
  return {
    processed: 0,
    billed: 0,
    alreadyBilled: 0,
    replayed: args.replayed ?? 0,
    replayBilled: 0,
    orphanedOrgs: 0,
    cursorFrom: args.cursorFrom,
    cursorTo: args.cursorTo,
    stalledOnId: args.stalledOnId ?? null,
  };
}

/**
 * One cursor sweep pass over the platform's append-only `llm_usage` ledger,
 * the EE billing consumer.
 *
 * EE owns its database, so it cannot SQL-join the platform ledger. It reads
 * the ledger through `services.usage.list({ afterId })` (a serial-`id` cursor)
 * and claims each billable row by inserting a marker into the EE-owned
 * `ee_billed_llm_usage` side-car with `ON CONFLICT (llm_usage_id) DO NOTHING
 * RETURNING`. The `RETURNING` set is exactly the rows THIS pass won, so a
 * re-read of already-processed rows is a cheap no-op. Open-core boundary
 * preserved: the OSS schema carries zero billing concepts.
 *
 * Ordering contract (see `LlmUsageLedgerRow.settled`):
 *   - Process the leading run of rows the watermark may safely pass, the
 *     "frontier". A SETTLED row is always in the frontier. An UNSETTLED row
 *     stalls the frontier ONLY when its `credentialSource` is `system` (a row
 *     EE WILL bill once it settles: a runner row's `cost_usd` grows until its
 *     run reaches a terminal status, so billing it early would under-count).
 *     An unsettled NON-system row (BYOK / null) is never billed and its
 *     `credentialSource` is fixed at first insert, so the watermark advances
 *     PAST it, and a long BYOK run can no longer block billing for every org.
 *   - Scan from `watermark − CLOUD_RECONCILIATION_REPLAY_WINDOW`, not from the
 *     watermark. A serial `id` is taken at INSERT but published at COMMIT, so a
 *     row can appear BELOW an already-advanced watermark and would otherwise be
 *     unreachable — and therefore unbilled and unlogged — forever. The window is
 *     a READ offset only; the committed watermark never moves backwards.
 *   - Advance the watermark to the last frontier row id, in the SAME EE-DB
 *     transaction as the claims/debits. On any error nothing advances and the
 *     next pass retries from the last committed id. A stalled watermark (first
 *     row an unsettled system row) simply re-reads next pass; the claim table
 *     dedups. The advance is monotonic (`GREATEST`) so two overlapping sweepers
 *     can never rewind the watermark to a smaller frontier and thrash a
 *     re-sweep.
 *
 * Fault isolation: an org with billable usage and no billing account is
 * recorded, reported and skipped — never fatal (see {@link OrphanedOrgDebt}).
 *
 * Cutover: the watermark is seeded at the platform's settled frontier
 * (`usage.settledFrontier()`, the highest id below which every row is settled)
 * by {@link ensureCursorSeeded} — normally in the module's `init()` at boot, so
 * this pass just reads an existing cursor. Should a pass ever find the cursor
 * still absent it seeds it here (safety net) and bills nothing. Seeding at a
 * plain `MAX(id)` would strand any in-flight runner row that already holds a low
 * id; the settled frontier stops before the first unsettled row so none is lost.
 *
 * Rows already claimed (billed by the previous model) are never re-billed — the
 * claim table dedupes. The first sweep starts at the settled frontier, so
 * settled-but-unclaimed rows ABOVE it (the recent window since the oldest
 * in-flight run began) ARE billed on the first pass — deliberate, so an
 * in-flight run's revenue is not stranded; rows below the frontier are never
 * revisited.
 */
export async function sweepLedgerBatch(
  batchSize: number,
  hooks?: SweepHooks,
): Promise<SweepResult> {
  const services = getPlatformServices();
  const db = getEeDb();

  // 1. Load the watermark. Normally `init()` already seeded it at boot (closing
  //    the cutover loss window); this is the safety-net path — a pass that finds
  //    the cursor still absent seeds it at the platform's settled frontier and
  //    bills nothing, exactly as init would have.
  const seed = await ensureCursorSeeded(services, db);
  if (seed.seeded) {
    // Cutover: the watermark was just placed at the settled frontier and this
    // pass bills nothing. No replay either — everything below a freshly seeded
    // frontier is deliberately out of scope (see the cutover note above), and
    // reading it would only re-confirm that.
    return noProgress({ cursorFrom: 0, cursorTo: seed.lastLlmUsageId });
  }

  const fromId = seed.lastLlmUsageId;

  // 2. Fetch the batch — starting BELOW the watermark by the replay window.
  //
  //    WHY WE RE-READ ROWS WE ALREADY PASSED. A serial `id` is assigned at
  //    INSERT and becomes visible at COMMIT, and those orders differ: the
  //    transaction holding id 100 can commit AFTER the one holding id 101. A
  //    pass landing in that window bills 101 and advances the watermark past
  //    100, and `WHERE id > watermark` can then never return row 100 again — it
  //    is never billed and nothing logs it. Re-reading a bounded window below
  //    the watermark is what makes such a row reachable on a later pass. It
  //    costs one indexed range scan and debits nothing on the rows already
  //    claimed, because `ee_billed_llm_usage` — not the cursor — is the
  //    arbiter of what has been billed. Do not remove it as redundant work: the
  //    redundancy is the entire point, and the bug it prevents is silent.
  //
  //    The window is a READ offset ONLY. `scanFromId` never becomes the
  //    watermark; the committed advance stays `GREATEST`-guarded below, so the
  //    watermark is still strictly monotonic.
  const replayWindow = getEeEnv().CLOUD_RECONCILIATION_REPLAY_WINDOW;
  const scanFromId = Math.max(0, fromId - replayWindow); // clamped: a fresh cursor cannot underflow
  const replaySpan = fromId - scanFromId; // == min(replayWindow, fromId)

  //    Read the replay span ON TOP of the batch, never out of it: at most
  //    `replaySpan` returned rows can have `id <= fromId`, so the FORWARD slice
  //    still gets its full `batchSize` and the drain loop's backlog accounting
  //    keeps meaning what it says. Clamped at the platform ceiling; the env
  //    bounds (replay ≤ 500, batch ≤ 1000) keep forward capacity ≥ 500 rows
  //    even at that clamp, so no combination of the two knobs can wedge the
  //    sweeper.
  const limit = Math.min(replaySpan + batchSize, LEDGER_LIST_MAX_LIMIT);
  const rows = await services.usage.list({ afterId: scanFromId, limit });
  if (rows.length === 0) {
    // Caught up, nothing to sweep. Not a stall.
    return noProgress({ cursorFrom: fromId, cursorTo: fromId });
  }

  // Rows the replay window surfaced. Non-zero is the healthy steady state (it
  // proves the window is actually being scanned); what matters is how many of
  // them turn out to be UNCLAIMED, computed after the claim below.
  const replayed = rows.reduce((n, r) => (r.id <= fromId ? n + 1 : n), 0);

  // 3. Frontier: the leading run of rows the watermark may safely pass. Settled
  //    rows always qualify. An unsettled row stalls the frontier ONLY when it is
  //    a `system` row (EE will bill it once it settles); an unsettled
  //    NON-system row (BYOK / null) is never billed and its `credentialSource`
  //    is immutable from first insert, so we advance past it (it counts as
  //    processed, never billed) instead of letting a long BYOK run wedge billing
  //    for every other org.
  //
  //    THE BLOCKING ROW MAY SIT BELOW THE WATERMARK. Before the replay window
  //    that could not happen — an unsettled system row was only ever met at the
  //    frontier. Now a row that committed late, under an already-advanced
  //    watermark, is read again, and if it is still unsettled it stalls billing
  //    for EVERY tenant from underneath the watermark. That is the deliberate
  //    trade, and it is load-bearing rather than a side effect: the stall is
  //    exactly what stops the watermark from running past `row_id + replayWindow`
  //    and letting the row fall out of the replay window unbilled. A fleet-wide
  //    delay is accepted to make the loss impossible — the same trade this module
  //    already makes for an unsettled system row at the head. Do NOT "fix" it by
  //    skipping unsettled rows in the replay region: that silently restores the
  //    loss for any run outliving the window. The stall is bounded by run
  //    duration, and by orphan cleanup marking crashed runs terminal in the
  //    failure case.
  const frontier: LlmUsageLedgerRow[] = [];
  let blockedOnId: number | null = null;
  for (const row of rows) {
    if (!row.settled && row.credentialSource === "system") {
      blockedOnId = row.id;
      break;
    }
    frontier.push(row);
  }
  if (frontier.length === 0) {
    // First row is an unsettled system row, so we cannot advance. Bounded by run
    // duration; orphan cleanup marks crashed runs terminal. Surface the blocking
    // row id so the sweeper can flag a head-of-line stall.
    return noProgress({
      cursorFrom: fromId,
      cursorTo: fromId,
      stalledOnId: blockedOnId,
      replayed,
    });
  }

  // Forward progress only: rows at or below the watermark were advanced over by
  // an earlier pass, so counting them here would inflate `processed` and make
  // the drain loop's `processed >= batchSize` backlog test fire on a ledger that
  // is fully caught up — spinning the tick to its iteration cap forever.
  const processed = frontier.reduce((n, r) => (r.id > fromId ? n + 1 : n), 0);

  // A frontier that ends inside the replay region (an unsettled `system` row
  // that committed below the watermark) yields a `newCursor` BELOW `fromId`.
  // That is exactly what `GREATEST` is for: the watermark holds, the row is
  // billed once it settles, and nothing rewinds.
  const newCursor = frontier[frontier.length - 1]!.id;
  // Only SETTLED, platform-provided ("system") rows are billable. Org-credential,
  // null-credential, and any unsettled non-system rows in the frontier advance
  // the watermark but are never debited.
  const billableRows = frontier.filter((r) => r.settled && r.credentialSource === "system");

  // 4. Claim + debit + advance the watermark, one transaction.
  const outcome = await db.transaction(async (tx) => {
    const result = await billLedgerRows(tx, billableRows);

    // Advance the watermark in the same transaction as the debits. Monotonic
    // (`GREATEST`) so two overlapping sweepers can't rewind it to a smaller
    // frontier: a later commit with a lower `newCursor` is a no-op, not a
    // regression that would re-sweep and thrash the claim table. (Even a
    // deliberate operator rewind is safe: the claim table is never purged, so a
    // re-read of already-billed rows debits nothing.)
    await tx
      .update(billingCursor)
      .set({
        lastLlmUsageId: sql`GREATEST(${billingCursor.lastLlmUsageId}, ${newCursor})`,
        updatedAt: new Date(),
      })
      .where(eq(billingCursor.id, true));

    // Test-only seam: force a failure INSIDE the transaction to prove the pass
    // rolls back atomically (cursor + credits + claims all revert).
    if (hooks?.onBeforeCommit) await hooks.onBeforeCommit();

    return result;
  });

  // Post-commit: overshoot logs + threshold-warning emails (fire-and-forget),
  // and the loud report for orgs that could not be debited.
  for (const debit of outcome.debits) emitQuotaSignals(debit);
  for (const orphan of outcome.orphans) reportOrphanedOrg(orphan);

  // Split the claim outcome around the watermark. Both halves come from the ONE
  // claim statement above, so the two counters can never disagree with what was
  // actually debited:
  //   - above the watermark → the ordinary forward claim. Rows there have never
  //     been read before, so `alreadyBilled` remains the genuine "something
  //     re-seeded the cursor or two sweepers overlap" signal;
  //   - at or below it → the replay window. Already-claimed rows are the
  //     expected case and are NOT counted as `alreadyBilled` (that would fire
  //     every tick and drown the real signal). A row billed here for the first
  //     time is the serial-visibility race being caught red-handed.
  const wonAbove = outcome.billedIds.reduce((n, id) => (id > fromId ? n + 1 : n), 0);
  const billableAbove = billableRows.reduce((n, r) => (r.id > fromId ? n + 1 : n), 0);

  return {
    processed,
    billed: outcome.billed,
    alreadyBilled: billableAbove - wonAbove,
    replayed,
    replayBilled: outcome.billed - wonAbove,
    orphanedOrgs: outcome.orphans.length,
    cursorFrom: fromId,
    // The watermark is monotonic, so report what was actually committed, not the
    // frontier end — they differ when the frontier stopped inside the replay
    // region.
    cursorTo: Math.max(fromId, newCursor),
    // A stall is only reported when the pass made NO forward progress; a pass
    // that advanced simply re-reads the blocking row next time.
    stalledOnId: processed === 0 ? blockedOnId : null,
  };
}

/**
 * Report an org whose usage could not be debited because it has no billing
 * account. `error` level and one line per occurrence: this is a revenue fault
 * that needs an operator, and it used to be invisible (the pass aborted with a
 * generic "billing sweep tick crashed" that named no org).
 */
export function reportOrphanedOrg(orphan: OrphanedOrgDebt): void {
  logger.error("billable usage for an org with no billing account — recorded, NOT debited", {
    orgId: orphan.orgId,
    deltaCredits: orphan.deltaCredits,
    // The debt is durable in ee_usage_records; this re-provisions the account
    // and applies it.
    repair: `bun run repair:account -- ${orphan.orgId} <owner-email>`,
  });
}

/**
 * Soft-cap overshoot log + one-shot 80% quota-warning email for a single org's
 * debit. Fires at most once per quota crossing (previous < 80% <= current).
 */
function emitQuotaSignals(debit: AccountDebit): void {
  const { orgId, deltaCredits, creditsUsed, creditQuota, planId } = debit;

  if (creditsUsed > creditQuota) {
    logger.warn("Credit quota exceeded after billing sweep (soft cap overshoot)", {
      orgId,
      deltaCredits,
      creditsUsed,
      creditQuota,
    });
  }

  if (creditQuota > 0) {
    const previousCredits = creditsUsed - deltaCredits;
    const previousPercent = previousCredits / creditQuota;
    const currentPercent = creditsUsed / creditQuota;

    if (previousPercent < QUOTA_WARNING_THRESHOLD && currentPercent >= QUOTA_WARNING_THRESHOLD) {
      const plan = getPlans()[planId];
      sendBillingEmail(orgId, "quota-warning", {
        planName: plan?.name ?? planId,
        usagePercent: Math.round(currentPercent * 100),
        creditsUsed,
        creditQuota,
        upgradeUrl: "/settings/billing",
        locale: "fr",
      });
    }
  }
}
