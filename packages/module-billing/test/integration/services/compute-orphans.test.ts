// SPDX-License-Identifier: Apache-2.0

/**
 * Compute rows of deleted organizations. A settlement pass that lands between `onOrgDelete`
 * and the platform's cascade recreates counters for an org that is about to vanish; the
 * purge asks the platform which orgs still exist and drops the rest.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { getBillingDb, truncateBillingTables } from "../../helpers/db.ts";
import { seedComputeCursor, seedComputeUsage, seedTerminalRun } from "../../helpers/seed.ts";
import { seedOrgMembers } from "../../helpers/org-queries.ts";
import { useBillingTestSeams } from "../../helpers/setup.ts";
import { purgeOrphanedOrgs } from "../../../src/compute/orphans.ts";
import { settleTerminalRuns } from "../../../src/compute/settlement.ts";
import { periodStartOf } from "../../../src/compute/period.ts";
import { computeUsage, settledRuns } from "../../../drizzle/schema.ts";

useBillingTestSeams();

const liveOrg = "00000000-0000-4000-a000-000000000c01";
const deletedOrg = "00000000-0000-4000-a000-000000000c02";
const THIS_MONTH = periodStartOf(new Date());

describe("purgeOrphanedOrgs", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedComputeCursor();
    seedOrgMembers(liveOrg, []);
  });

  it("drops the counters and claims of an org the platform no longer knows, and only those", async () => {
    seedTerminalRun({ orgId: liveOrg, durationMs: 10_000, completedAt: new Date() });
    // The race: the org's rows come back after `onOrgDelete` removed them.
    seedTerminalRun({
      orgId: deletedOrg,
      durationMs: 20_000,
      completedAt: new Date(Date.now() + 1),
    });
    await settleTerminalRuns();
    expect((await getBillingDb().select().from(computeUsage)).map((r) => r.orgId).sort()).toEqual([
      liveOrg,
      deletedOrg,
    ]);

    expect(await purgeOrphanedOrgs()).toBe(1);

    const usage = await getBillingDb().select().from(computeUsage);
    const claims = await getBillingDb().select().from(settledRuns);
    expect(usage.map((r) => r.orgId)).toEqual([liveOrg]);
    expect(claims.map((r) => r.orgId)).toEqual([liveOrg]);
  });

  it("leaves every org alone when all of them still exist", async () => {
    await seedComputeUsage({ orgId: liveOrg, periodStart: THIS_MONTH, secondsUsed: 90 });
    expect(await purgeOrphanedOrgs()).toBe(0);
    expect(await getBillingDb().select().from(computeUsage)).toHaveLength(1);
  });
});
