// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Plan → file-storage entitlement projection.
 *
 * The platform enforces the per-org storage limit synchronously inside its
 * file-write transaction; EE is the logical owner of that value and
 * projects the billing plan onto it via the
 * `PlatformServices.setFileStorageLimit` capability. Unlike credits
 * (renewable budget, swept asynchronously), storage is persistent capacity —
 * the exact counter and admission stay in the core transaction; EE only
 * writes the ceiling.
 *
 * Sync points:
 *  - every plan transition (org creation, checkout, subscription
 *    created/updated/deleted, renewal) → `syncOrgStorageEntitlement`
 *  - a throttled periodic reconcile (`resyncAllStorageEntitlements`, started by
 *    the billing sweeper tick) that blind-rewrites every account's entitlement —
 *    idempotent, backfills pre-existing orgs and repairs any transition sync
 *    that failed (the two DBs share no transaction).
 *
 * EE ALWAYS writes an explicit byte value, never null: null would clear the
 * override and drop the org to the deployment-global `ORG_STORAGE_QUOTA_BYTES`
 * fallback, which is an OSS knob, not a plan entitlement. Downgrading below
 * current usage is safe by design — the platform blocks new writes and never
 * evicts existing files.
 *
 * An unknown `planId` (defensive: plans are config, accounts are data) maps to
 * the free plan's entitlement.
 */

import { eq } from "drizzle-orm";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { getPlans, isPlanId } from "../config.ts";
import { getPlatformServices } from "../platform.ts";
import { logger } from "../logger.ts";

/**
 * `setFileStorageLimit` is a required member of `PlatformServices`, so the
 * capability is read directly — no structural probe, no missing-capability
 * fallback.
 *
 * The name is read off the LIVE services object the platform injects, not off
 * this module's pinned `PlatformServices` type, so a platform-side rename does
 * not rename the read here — it turns the next boot into a `TypeError`. The two
 * therefore move in lockstep: this line ships BEFORE (or with) the platform
 * build that renames the capability.
 */
function getSetter(): (orgId: string, bytes: number | null) => Promise<void> {
  const services = getPlatformServices();
  return services.setFileStorageLimit.bind(services);
}

/** Resolve a plan id to its storage entitlement in bytes (unknown → free). */
export function storageEntitlementForPlan(planId: string): number {
  const plans = getPlans();
  return (isPlanId(planId) ? plans[planId] : plans.free).fileStorageBytes;
}

/**
 * One write attempt can race a concurrent plan transition (a Stripe webhook
 * committing between our plan read and our platform write would be overwritten
 * with a stale value). The post-write recheck catches that and retries once
 * with the fresh plan; a plan still moving after the retry is left to the next
 * transition sync / hourly reconcile (bounded — never loop on a flapping plan).
 */
const MAX_PROJECTION_ATTEMPTS = 2;

type ProjectionOutcome = "synced" | "skipped" | "failed";

async function projectOrgEntitlement(
  orgId: string,
  setter: (orgId: string, bytes: number | null) => Promise<void>,
  opts: { logSuccess?: boolean } = {},
): Promise<ProjectionOutcome> {
  const db = getEeDb();
  for (let attempt = 1; ; attempt++) {
    // Read the plan at the last moment, right before the write — never from a
    // caller-held snapshot (see resyncAllStorageEntitlements).
    const [account] = await db
      .select({ planId: billingAccounts.planId })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    if (!account) {
      // Org deleted (or never provisioned) between the transition and this
      // sync — nothing to project; org deletion tears down the platform org.
      return "skipped";
    }

    const bytes = storageEntitlementForPlan(account.planId);
    try {
      await setter(orgId, bytes);
    } catch (err) {
      logger.error("failed to sync storage entitlement", {
        orgId,
        planId: account.planId,
        bytes,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }

    // Stale-write guard: if the plan changed while the write was in flight,
    // the value just written is obsolete — re-project the fresh plan.
    const [recheck] = await db
      .select({ planId: billingAccounts.planId })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    const planMoved = recheck !== undefined && recheck.planId !== account.planId;
    if (planMoved && attempt < MAX_PROJECTION_ATTEMPTS) continue;

    if (planMoved) {
      logger.warn("plan changed again during entitlement retry — deferring to next sync", {
        orgId,
        writtenPlanId: account.planId,
        currentPlanId: recheck.planId,
      });
    }
    if (opts.logSuccess !== false) {
      logger.info("storage entitlement synced", { orgId, planId: account.planId, bytes });
    }
    return "synced";
  }
}

/**
 * Project one org's current plan onto its platform storage limit. Idempotent
 * (the platform write is a plain UPDATE) and best-effort: callers sit on
 * webhook/onboarding paths that must not fail because the platform write did —
 * the periodic reconcile repairs any miss. Returns true when the write landed.
 */
export async function syncOrgStorageEntitlement(orgId: string): Promise<boolean> {
  return (await projectOrgEntitlement(orgId, getSetter())) === "synced";
}

/**
 * Reconcile every billing account's storage entitlement. Blind idempotent
 * rewrite — no drift detection needed (EE has no read capability on the
 * platform limit, and one UPDATE per org per pass is cheap at current scale).
 * Serves as both the backfill for orgs created before this feature and the
 * repair loop for failed transition syncs.
 *
 * Only org ids are enumerated up front; each org's plan is read inside
 * `projectOrgEntitlement` right before its write. A fleet-wide
 * `(orgId, planId)` snapshot would go stale over the pass — a plan transition
 * committing mid-pass would be overwritten with the pre-transition value and
 * stay wrong until the next pass.
 *
 * BOUNDED CONCURRENCY: orgs are projected `concurrency` at a time (2 EE reads
 * + 1 platform write each). Strictly serial — the previous behavior — a
 * 10 000-org fleet costs minutes of wall clock; unbounded, it would burst 10 000
 * concurrent platform writes. The caller (`billing-sweeper.ts`) owns the
 * cadence: this function is a pure pass and never schedules itself.
 *
 * Per-org failures are caught inside `projectOrgEntitlement`, so this resolves
 * normally even when EVERY org fails. `failed` is therefore the only signal a
 * caller has that the pass repaired nothing — it must be consulted before
 * treating the pass as successful.
 */
export interface ResyncResult {
  synced: number;
  failed: number;
  /** Orgs whose account vanished mid-pass — neither a sync nor a fault. */
  skipped: number;
}

export async function resyncAllStorageEntitlements(concurrency = 8): Promise<ResyncResult> {
  const setter = getSetter();
  const db = getEeDb();
  const accounts = await db.select({ orgId: billingAccounts.orgId }).from(billingAccounts);

  const result: ResyncResult = { synced: 0, failed: 0, skipped: 0 };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const account = accounts[next++];
      if (!account) return;
      const outcome = await projectOrgEntitlement(account.orgId, setter, { logSuccess: false });
      if (outcome === "synced") result.synced++;
      else if (outcome === "failed") result.failed++;
      else result.skipped++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));

  return result;
}
