// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Final billing drain for one organization, run from `onOrgDelete`.
 *
 * WHY THIS EXISTS
 *
 * The periodic cursor sweep runs every `EE_RECONCILIATION_INTERVAL_SECONDS`
 * (300 s by default). An org that spends and then deletes itself inside that
 * window was never debited: `onOrgDelete` dropped its `ee_billing_accounts`
 * row, and the platform's org cascade then removed its `llm_usage` rows — so
 * the next sweep could not even observe the loss. Repeatable at will.
 *
 * WHY IT IS SAFE HERE
 *
 * The platform `await`s `onOrgDelete` BEFORE it cascades, and it refuses to
 * delete an organization while a run is active. At this instant every runner row
 * of the org is therefore terminal — hence settled, hence billable. The window
 * exists and this drains it.
 *
 * INVARIANTS
 *
 *   - The GLOBAL watermark is never touched. The drain reads forward from it and
 *     bills only THIS org's rows; the periodic sweep re-reads the same rows later
 *     and finds them already claimed (`ee_billed_llm_usage` is the arbiter),
 *     so it is a no-op for them. Nothing is rewound, and the drain can bill an
 *     org sitting behind another tenant's head-of-line stall.
 *   - It starts where the SWEEP starts, from the one shared `ledgerScanStart`.
 *     Starting strictly at the watermark loses the rows the replay window exists
 *     for, and here that loss is final: the org's ledger rows cascade away
 *     moments later and no sweep will ever replay them.
 *   - Bounded: at most {@link MAX_DRAIN_BATCHES} reads of the configured batch
 *     size, and the scan is narrowed server-side to `credentialSource: "system"`
 *     (the only billable rows). A truncated drain is reported at `warn`.
 */

import { getEeDb } from "../db.ts";
import { getPlatformServices } from "../platform.ts";
import { getEeEnv } from "../env.ts";
import { logger } from "../logger.ts";
import {
  addPricingFaults,
  billLedgerRows,
  ensureCursorSeeded,
  ledgerScanStart,
  noPricingFaults,
  reportOrphanedOrg,
  reportPricingFaults,
  type PricingFaults,
} from "./usage-recorder.ts";

/**
 * Max ledger reads per drain. With the default batch size (100) that scans
 * 5 000 system rows past the watermark — far beyond one sweep interval of
 * backlog — while keeping org deletion a bounded operation.
 */
const MAX_DRAIN_BATCHES = 50;

export interface OrgDrainResult {
  /** Ledger rows belonging to this org seen past the watermark. */
  scanned: number;
  /** Rows this drain newly claimed and billed. */
  billed: number;
  /** Rows already claimed by an earlier sweep pass. */
  alreadyBilled: number;
  /** Credits debited to the org's account by this drain. */
  credits: number;
  /**
   * Org rows skipped because they were not settled. Expected to be 0 — the
   * platform blocks deletion while a run is active — so a non-zero value is a
   * real signal, not noise.
   */
  unsettled: number;
  /** True when the drain hit {@link MAX_DRAIN_BATCHES} and stopped early. */
  truncated: boolean;
  /** Rows the drain claimed that the platform could not price in full. */
  pricing: PricingFaults;
}

/**
 * Bill everything this org owes, now. Returns what it did; never throws for
 * "nothing to do".
 */
export async function drainOrgUsage(orgId: string): Promise<OrgDrainResult> {
  const services = getPlatformServices();
  const db = getEeDb();
  const batchSize = getEeEnv().EE_RECONCILIATION_BATCH_SIZE;

  // Same selection policy as the sweep. Re-reading rows an earlier pass claimed
  // costs nothing: the claim table, not the cursor, arbitrates what was billed.
  const cursor = await ensureCursorSeeded(services, db);

  const result: OrgDrainResult = {
    scanned: 0,
    billed: 0,
    alreadyBilled: 0,
    credits: 0,
    unsettled: 0,
    truncated: false,
    pricing: noPricingFaults(),
  };

  let afterId = ledgerScanStart(cursor);
  for (let batch = 0; ; batch++) {
    if (batch >= MAX_DRAIN_BATCHES) {
      result.truncated = true;
      break;
    }
    // `credentialSource: "system"` narrows the scan to the only billable rows,
    // server-side — a deleted org's drain must not walk the whole ledger tail.
    const rows = await services.usage.list({
      afterId,
      limit: batchSize,
      credentialSource: "system",
    });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    const orgRows = rows.filter((r) => r.orgId === orgId);
    result.scanned += orgRows.length;
    const billable = orgRows.filter((r) => r.settled);
    result.unsettled += orgRows.length - billable.length;

    if (billable.length > 0) {
      const outcome = await db.transaction((tx) => billLedgerRows(tx, billable));
      result.billed += outcome.billed;
      result.alreadyBilled += outcome.alreadyBilled;
      result.pricing = addPricingFaults(result.pricing, outcome.pricing);
      for (const debit of outcome.debits) result.credits += debit.deltaCredits;
      for (const orphan of outcome.orphans) reportOrphanedOrg(orphan);
    }

    if (rows.length < batchSize) break;
  }

  // One line for the whole drain, not one per batch.
  reportPricingFaults(result.pricing, `org drain ${orgId}`);

  return result;
}

/**
 * Drain + report. The org row and its `ee_usage_records` are about to be
 * deleted, so this log line is the durable trace of the org's final billed
 * usage — emit it even when the drain found nothing to bill only if something
 * was actually scanned, to keep steady-state deletions quiet.
 */
export async function drainOrgUsageOnDelete(orgId: string): Promise<OrgDrainResult | null> {
  try {
    const result = await drainOrgUsage(orgId);
    if (result.scanned > 0) {
      logger.info("final usage drained before org deletion", { orgId, ...result });
    }
    if (result.truncated) {
      logger.warn("final usage drain truncated at the batch cap — some usage may be unbilled", {
        orgId,
        maxBatches: MAX_DRAIN_BATCHES,
      });
    }
    if (result.unsettled > 0) {
      logger.warn("org deleted with unsettled ledger rows — not billed", {
        orgId,
        unsettled: result.unsettled,
      });
    }
    return result;
  } catch (err) {
    // Never let a drain failure block the deletion cleanup that follows: the
    // platform is already committed to removing this org.
    logger.error("final usage drain failed before org deletion", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
