// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Cursor-based billing sweep — the EE metering consumer.
 *
 * EE consumes the platform's append-only `llm_usage` ledger by serial-`id`
 * watermark (`ee_billing_cursor`). Each pass reads the next batch through
 * the mock `PlatformServices.usage.list`, bills the leading run of consecutive
 * SETTLED rows (the "frontier"), claims platform-provided ("system") rows into
 * `ee_billed_llm_usage`, debits credits, and advances the watermark — all in
 * one transaction. These tests pin that contract.
 */
import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import {
  seedBillingAccount,
  seedLlmUsage,
  seedBillingCursor,
  markLlmUsageBilled,
} from "../../helpers/seed.ts";
import {
  mockLedger,
  mockPlatformServices,
  setMockLedgerError,
  setMockLedgerListHook,
} from "../../helpers/mock-platform.ts";
import {
  runBillingSweep,
  runBillingSweepTick,
  startBillingSweeper,
  stopBillingSweeper,
  _resetBillingSweeperForTests,
} from "../../../src/billing/billing-sweeper.ts";
import {
  sweepLedgerBatch,
  ensureCursorSeeded,
  type SweepResult,
} from "../../../src/billing/usage-recorder.ts";
import { _resetEeEnvForTests } from "../../../src/env.ts";
import { initBillingEmail } from "../../../src/emails/send.ts";
import { logger } from "../../../src/logger.ts";
import {
  billingAccounts,
  orgUsageRecords,
  billingCursor,
  eeBilledLlmUsage,
} from "../../../drizzle/schema.ts";
import { useEeReconciliationEnv, useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();
useEeReconciliationEnv();

const orgId = "00000000-0000-4000-a000-000000000010";

async function creditsUsed(org = orgId): Promise<number> {
  const db = getEeDb();
  const [account] = await db
    .select({ creditsUsed: billingAccounts.creditsUsed })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, org));
  return account!.creditsUsed;
}

async function cursorValue(): Promise<number> {
  const db = getEeDb();
  const [row] = await db
    .select({ lastLlmUsageId: billingCursor.lastLlmUsageId })
    .from(billingCursor)
    .where(eq(billingCursor.id, true));
  return row!.lastLlmUsageId;
}

describe("billing sweep — cursor consumer", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 20000 });
  });

  it("initializes the cursor at the current max id and bills nothing (cutover)", async () => {
    // Historical rows exist before EE ever swept.
    seedLlmUsage({ orgId, costUsd: 0.25 });
    seedLlmUsage({ orgId, costUsd: 0.5 });

    const result = await runBillingSweep();

    expect(result.billed).toBe(0);
    expect(result.cursorTo).toBe(2);
    expect(await cursorValue()).toBe(2);
    expect(await creditsUsed()).toBe(0); // historical rows never retro-billed
  });

  it("initializes the cursor at 0 for an empty ledger", async () => {
    const result = await runBillingSweep();
    expect(result.cursorTo).toBe(0);
    expect(await cursorValue()).toBe(0);
  });

  it("bills a settled system row and advances the watermark", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1 → 50 credits

    const result = await runBillingSweep();

    expect(result.billed).toBe(1);
    expect(result.cursorTo).toBe(1);
    expect(await creditsUsed()).toBe(50);

    const db = getEeDb();
    const records = await db.select().from(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
    expect(records).toHaveLength(1);
    expect(records[0]!.contextType).toBe("run");
    expect(records[0]!.costCredits).toBe(50);
  });

  it("stops the watermark at the first unsettled row (frontier)", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1 settled
    seedLlmUsage({ orgId, costUsd: 0.1, settled: false }); // id 2 unsettled (mid-run)
    seedLlmUsage({ orgId, costUsd: 0.2 }); // id 3 settled — beyond the frontier

    const result = await runBillingSweep();

    // Only id 1 processed; watermark stops before id 2.
    expect(result.processed).toBe(1);
    expect(result.billed).toBe(1);
    expect(await cursorValue()).toBe(1);
    expect(await creditsUsed()).toBe(50);

    // The run settles; the next pass advances through id 2 and id 3.
    mockLedger.find((r) => r.id === 2)!.settled = true;
    await runBillingSweep();
    expect(await cursorValue()).toBe(3);
    expect(await creditsUsed()).toBe(50 + 100 + 200);
  });

  it("never advances when the very first row is unsettled", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.1, settled: false }); // id 1 unsettled

    const result = await runBillingSweep();
    expect(result.processed).toBe(0);
    expect(await cursorValue()).toBe(0);
    expect(await creditsUsed()).toBe(0);
  });

  it("is idempotent — re-reading claimed rows (rewound cursor) bills once", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1
    seedLlmUsage({ orgId, costUsd: 0.1 }); // id 2

    await runBillingSweep(); // bills both, cursor → 2
    expect(await creditsUsed()).toBe(150);

    // Force a re-read of already-claimed rows (as would happen if a crash lost a
    // cursor advance). The claim table (`ee_billed_llm_usage`) dedups them.
    await seedBillingCursor(0);
    const result = await runBillingSweep();
    expect(result.billed).toBe(0);
    expect(result.alreadyBilled).toBe(2);
    expect(await creditsUsed()).toBe(150); // no double debit
    expect(await cursorValue()).toBe(2);
  });

  it("does not double-bill a row already claimed by an earlier pass", async () => {
    await seedBillingCursor(0);
    const id = seedLlmUsage({ orgId, costUsd: 0.05 });
    await markLlmUsageBilled({ llmUsageId: id }); // pretend a prior pass claimed it

    const result = await runBillingSweep();

    expect(result.billed).toBe(0);
    expect(result.alreadyBilled).toBe(1);
    expect(await creditsUsed()).toBe(0); // no double debit
    expect(await cursorValue()).toBe(1); // still advances past it
  });

  it("never bills org-credential rows but still advances past them", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.5, credentialSource: "org" }); // id 1 BYOK

    const result = await runBillingSweep();

    expect(result.billed).toBe(0);
    expect(await creditsUsed()).toBe(0);
    expect(await cursorValue()).toBe(1);
  });

  it("never bills null-credential rows but still advances past them", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.5, credentialSource: null });

    await runBillingSweep();

    expect(await creditsUsed()).toBe(0);
    expect(await cursorValue()).toBe(1);
  });

  it("debits null-context system rows into a durable unattributed org bucket", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextType: null, contextId: null });

    await runBillingSweep();

    expect(await creditsUsed()).toBe(50); // debited

    const db = getEeDb();
    const records = await db.select().from(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
    expect(records).toHaveLength(1);
    expect(records[0]!.contextType).toBe("unattributed");
    expect(records[0]!.contextId).toBe(orgId);
    expect(records[0]!.costCredits).toBe(50);
  });

  it("carries null-context sub-credit fractions across separate sweeps", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.0004, contextType: null, contextId: null });
    await runBillingSweep();
    expect(await creditsUsed()).toBe(0);

    seedLlmUsage({ orgId, costUsd: 0.0004, contextType: null, contextId: null });
    await runBillingSweep();

    // Cumulative $0.0008 → round(0.8) = 1. The old per-pass conversion
    // rounded both $0.0004 rows to zero and lost them permanently.
    expect(await creditsUsed()).toBe(1);
    const db = getEeDb();
    const [record] = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, orgId));
    expect(record!.contextType).toBe("unattributed");
    expect(Number(record!.costUsd)).toBeCloseTo(0.0008, 6);
    expect(record!.costCredits).toBe(1);
  });

  it("bills a chat-context row and keys the usage record by chat session", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({
      orgId,
      costUsd: 0.03,
      source: "proxy",
      contextType: "chat",
      contextId: "sess-42",
    });

    await runBillingSweep();

    const db = getEeDb();
    const [record] = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "sess-42"));
    expect(record!.contextType).toBe("chat");
    expect(record!.costCredits).toBe(30);
    expect(await creditsUsed()).toBe(30);
  });

  it("carries a sub-credit row forward as cost_usd without debiting", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.0004 }); // rounds to 0 credits this pass

    const result = await runBillingSweep();

    expect(result.billed).toBe(1); // claimed
    expect(await creditsUsed()).toBe(0); // 0.0004 → round(0.4) = 0 credits
    // The context record still exists, carrying the raw dollars forward so a
    // later pass for the same context can cross the whole-credit boundary.
    const db = getEeDb();
    const records = await db.select().from(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
    expect(records).toHaveLength(1);
    expect(records[0]!.costCredits).toBe(0);
    expect(Number(records[0]!.costUsd)).toBeCloseTo(0.0004, 6);
  });

  it("aggregates multiple sub-threshold rows in one context before converting", async () => {
    await seedBillingCursor(0);
    // 3 rows that each round to 0 credits ALONE ($0.0004 → round(0.4) = 0), but
    // sum to $0.0012 → round(1.2) = 1 credit when aggregated per context first.
    const chatRow = { orgId, costUsd: 0.0004, source: "proxy" as const, contextType: "chat" as const, contextId: "sess-agg" }; // prettier-ignore
    seedLlmUsage(chatRow);
    seedLlmUsage(chatRow);
    seedLlmUsage(chatRow);

    await runBillingSweep();

    expect(await creditsUsed()).toBe(1); // aggregated, not floored to 0 per row

    const db = getEeDb();
    const [record] = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "sess-agg"));
    expect(record!.costCredits).toBe(1);
  });

  it("does not rewind a watermark a concurrent sweeper advanced mid-pass", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1 → this pass's frontier ends at 1

    // Simulate a second sweeper committing a higher watermark (9) after THIS
    // pass captured fromId=0 but before it commits its own advance to 1.
    setMockLedgerListHook(async () => {
      await seedBillingCursor(9);
      setMockLedgerListHook(null); // fire once
    });

    await runBillingSweep();

    // GREATEST guard keeps the higher watermark; it is NOT rewound to 1.
    expect(await cursorValue()).toBe(9);
  });

  it("debits multiple orgs in one batch", async () => {
    const otherOrgId = "00000000-0000-4000-a000-000000000011";
    await seedBillingAccount({ orgId: otherOrgId, creditsUsed: 0, creditQuota: 20000 });
    await seedBillingCursor(0);

    seedLlmUsage({ orgId, costUsd: 0.05 }); // 50
    seedLlmUsage({ orgId: otherOrgId, costUsd: 0.07 }); // 70

    await runBillingSweep();

    expect(await creditsUsed(orgId)).toBe(50);
    expect(await creditsUsed(otherOrgId)).toBe(70);
  });

  it("isolates an org with no billing account instead of freezing the whole fleet", async () => {
    // REGRESSION (fleet-wide outage). This used to `throw` INSIDE the sweep
    // transaction, rolling back the claims, the usage records AND the watermark
    // advance — so one account-less org froze billing for every tenant, forever,
    // and `credits_used` stopped moving fleet-wide (which in turn made the
    // `beforeUsage` admission gate stop rejecting anything).
    const missingAccountOrgId = "00000000-0000-4000-a000-000000000099";
    await seedBillingCursor(0);
    const orphanUsageId = seedLlmUsage({
      orgId: missingAccountOrgId,
      costUsd: 0.05,
      contextType: "run",
      contextId: "run-missing-account",
    });
    // A healthy tenant behind the account-less one.
    seedLlmUsage({ orgId, costUsd: 0.07, contextId: "run-healthy" });

    const errorSpy = spyOn(logger, "error");
    let orphanErrors: unknown[][];
    let result: SweepResult;
    try {
      result = await runBillingSweep();
      orphanErrors = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("no billing account"),
      );
    } finally {
      errorSpy.mockRestore();
    }

    // The pass committed: the watermark advanced past BOTH rows and the healthy
    // org was billed normally.
    expect(result!.orphanedOrgs).toBe(1);
    expect(await cursorValue()).toBe(2);
    expect(await creditsUsed(orgId)).toBe(70);

    // The account-less org is reported once, by id, at error level.
    expect(orphanErrors!).toHaveLength(1);
    expect(orphanErrors![0]![1]).toMatchObject({
      orgId: missingAccountOrgId,
      deltaCredits: 50,
    });

    // Its debt is NOT lost: the row is claimed (so it can never be double-billed
    // later) and the exact credits are durable in ee_usage_records, which is
    // what `repair:account` replays.
    const db = getEeDb();
    const claims = await db
      .select()
      .from(eeBilledLlmUsage)
      .where(eq(eeBilledLlmUsage.llmUsageId, orphanUsageId));
    expect(claims).toHaveLength(1);
    const records = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "run-missing-account"));
    expect(records).toHaveLength(1);
    expect(records[0]!.costCredits).toBe(50);
  });

  it("keeps billing every other tenant while an org stays account-less", async () => {
    // The failure mode was self-perpetuating: the same doomed rows replayed on
    // every tick. Prove the second tick is a clean no-op for the healthy org and
    // that the cursor keeps moving.
    const missingAccountOrgId = "00000000-0000-4000-a000-000000000098";
    await seedBillingCursor(0);
    seedLlmUsage({ orgId: missingAccountOrgId, costUsd: 0.05, contextId: "orphan-1" });
    seedLlmUsage({ orgId, costUsd: 0.01, contextId: "healthy-1" });
    await runBillingSweep();
    expect(await creditsUsed(orgId)).toBe(10);

    seedLlmUsage({ orgId, costUsd: 0.02, contextId: "healthy-2" });
    await runBillingSweep();

    expect(await creditsUsed(orgId)).toBe(30); // still billing
    expect(await cursorValue()).toBe(3);
  });

  it("accumulates repeated rows for the same context into one usage record", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.1, contextId: "run-x" });
    seedLlmUsage({ orgId, costUsd: 0.05, source: "proxy", contextId: "run-x" });

    await runBillingSweep();

    const db = getEeDb();
    const records = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "run-x"));
    expect(records).toHaveLength(1);
    expect(records[0]!.costCredits).toBe(150);
    expect(await creditsUsed()).toBe(150);
  });

  it("a single sweepLedgerBatch pass respects the batch size — overflow rides the next pass", async () => {
    // Batch-size capping is a per-PASS property of sweepLedgerBatch. The tick
    // (runBillingSweep) drains multiple passes — covered separately below — so
    // this asserts the primitive directly to keep the two concerns distinct.
    await seedBillingCursor(0);
    for (let i = 0; i < 5; i++) seedLlmUsage({ orgId, costUsd: 0.01 });

    const first = await sweepLedgerBatch(3);
    expect(first.processed).toBe(3);
    expect(await cursorValue()).toBe(3);

    const second = await sweepLedgerBatch(3);
    expect(second.processed).toBe(2);
    expect(await cursorValue()).toBe(5);
  });

  it("warns on the FIRST head-of-line stall, then throttles", async () => {
    // REGRESSION: the stall warning only fired every 10th consecutive stall, so
    // at the default 5-minute cadence the first signal that the global cursor
    // was wedged — which halts billing for EVERY tenant — arrived after ~50
    // minutes. It now fires immediately, carrying the blocking row id and how
    // long the stall has lasted, then throttles to one line per 10 stalls.
    _resetBillingSweeperForTests(); // reset the consecutive-stall counter
    await seedBillingCursor(0);
    const blockingId = seedLlmUsage({ orgId, costUsd: 0.1, settled: false }); // id 1 wedged

    const warnSpy = spyOn(logger, "warn");
    let stallWarns: unknown[][];
    try {
      await runBillingSweep();
      // Capture before mockRestore() — it clears the recorded calls.
      stallWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("stalled"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(stallWarns).toHaveLength(1); // the very first tick, not the tenth
    expect(stallWarns[0]![1]).toMatchObject({
      blockingLlmUsageId: blockingId,
      consecutiveStalls: 1,
      cursorAt: 0,
    });
    expect(stallWarns[0]![1]).toHaveProperty("stalledForSeconds");

    // Watermark never moved and nothing was billed.
    expect(await cursorValue()).toBe(0);
    expect(await creditsUsed()).toBe(0);
  });

  it("throttles a persistent stall to one line every 10 ticks", async () => {
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.1, settled: false }); // id 1 wedged

    const warnSpy = spyOn(logger, "warn");
    let stallWarns: unknown[][];
    try {
      for (let i = 0; i < 10; i++) await runBillingSweep();
      stallWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("stalled"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    // Stall 1 (immediate) + stall 10 (throttled repeat) — not ten lines.
    expect(stallWarns).toHaveLength(2);
    expect(stallWarns[1]![1]).toMatchObject({ consecutiveStalls: 10 });
  });

  it("emits exactly one heartbeat per tick, even when nothing is billed", async () => {
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.01, settled: false }); // id 1 wedged system row
    seedLlmUsage({ orgId, costUsd: 0.01 }); // id 2 settled, stuck behind it

    const infoSpy = spyOn(logger, "info");
    let ticks: unknown[][];
    try {
      await runBillingSweep();
      ticks = infoSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg === "billing sweep tick complete",
      );
    } finally {
      infoSpy.mockRestore();
    }

    // A tick that logs nothing is indistinguishable from a dead sweeper. The
    // watermark (`cursorTo`) standing still across ticks IS the "billing is
    // behind" signal — no extra platform round-trip is taken to restate it.
    expect(ticks).toHaveLength(1);
    expect(ticks[0]![1]).toMatchObject({ cursorTo: 0, stalledOnId: 1 });
  });

  it("warns when a tick re-reads already-claimed rows", async () => {
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    const id = seedLlmUsage({ orgId, costUsd: 0.05 });
    await markLlmUsageBilled({ llmUsageId: id });

    const warnSpy = spyOn(logger, "warn");
    let reReadWarns: unknown[][];
    try {
      await runBillingSweep();
      reReadWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("already-claimed"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    // `alreadyBilled > 0` means the cursor was re-seeded or two sweepers
    // overlapped. It used to be counted and never surfaced.
    expect(reReadWarns).toHaveLength(1);
    expect(reReadWarns[0]![1]).toMatchObject({ alreadyBilled: 1 });
  });

  it("escalates to error after N consecutive failing ticks", async () => {
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 });

    const warnSpy = spyOn(logger, "warn");
    const errorSpy = spyOn(logger, "error");
    let failureWarns: unknown[][];
    let failureErrors: unknown[][];
    try {
      for (let i = 0; i < 3; i++) {
        setMockLedgerError();
        const result = await runBillingSweepTick();
        expect(result).toBeNull(); // the tick swallows the error, never throws
      }
      failureWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("tick failed"),
      );
      failureErrors = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("consecutive ticks"),
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(failureWarns).toHaveLength(2); // ticks 1 and 2
    expect(failureErrors).toHaveLength(1); // tick 3 escalates
    expect(failureErrors[0]![1]).toMatchObject({ consecutiveFailures: 3 });

    // A subsequent healthy tick resets the counter.
    const ok = await runBillingSweepTick();
    expect(ok!.billed).toBe(1);
  });

  it("keeps a maintenance tick armed when metering is paused (INTERVAL=0)", async () => {
    // The regression: the early return on INTERVAL=0 armed NO timer, and the tick
    // is the only caller of `retryPendingCancellations()` — so a deleted org whose
    // Stripe cancel failed kept being charged for as long as metering stayed paused.
    _resetBillingSweeperForTests();
    process.env.EE_RECONCILIATION_INTERVAL_SECONDS = "0";
    _resetEeEnvForTests();

    const warnSpy = spyOn(logger, "warn");
    try {
      startBillingSweeper();
      // The re-entry guard warns only when a timer is actually armed.
      startBillingSweeper();
      expect(
        warnSpy.mock.calls.filter(([msg]) => msg === "billing sweeper already running"),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      stopBillingSweeper();
      _resetBillingSweeperForTests();
      _resetEeEnvForTests();
    }
  });

  it("does not advance the watermark when the ledger read fails", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 });
    setMockLedgerError();

    await expect(runBillingSweep()).rejects.toThrow("mock ledger read failure");
    expect(await cursorValue()).toBe(0);
    expect(await creditsUsed()).toBe(0);
  });

  it("cutover seeds the cursor at the settled frontier, not a plain max id", async () => {
    // id 1 settled, id 2 an in-flight (unsettled) runner row, id 3 settled.
    // A plain MAX(id) would seed at 3 and strand id 2 forever; the settled
    // frontier stops before the first unsettled row (→ 1).
    seedLlmUsage({ orgId, costUsd: 0.1 }); // id 1 settled
    seedLlmUsage({ orgId, costUsd: 0.2, settled: false }); // id 2 unsettled
    seedLlmUsage({ orgId, costUsd: 0.3 }); // id 3 settled

    const result = await runBillingSweep();

    expect(result.billed).toBe(0);
    expect(result.cursorTo).toBe(1);
    expect(await cursorValue()).toBe(1);
    expect(await creditsUsed()).toBe(0); // cutover bills nothing
  });

  it("advances past an unsettled ORG (BYOK) row instead of stalling", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.5, credentialSource: "org", settled: false }); // id 1 long BYOK run
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 2 settled system, beyond the org row

    const result = await runBillingSweep();

    // The BYOK row does NOT wedge the cursor: both rows are processed, the
    // watermark advances past id 1, and the settled system row is billed.
    expect(result.stalledOnId).toBeNull();
    expect(result.processed).toBe(2);
    expect(result.billed).toBe(1); // only the system row
    expect(await cursorValue()).toBe(2);
    expect(await creditsUsed()).toBe(50);
  });

  it("still stalls on an unsettled SYSTEM row at the head", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.1, credentialSource: "system", settled: false }); // id 1 wedged system run
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 2 settled, behind the stall

    const result = await runBillingSweep();

    expect(result.stalledOnId).toBe(1);
    expect(result.processed).toBe(0);
    expect(await cursorValue()).toBe(0);
    expect(await creditsUsed()).toBe(0);
  });

  it("bills the correct total when one context's cheap rows split across passes", async () => {
    // 8 rows × $0.0004 for ONE context, split 4/4 across two passes.
    // Per-pass conversion would bill round(0.0016×1000)=2 each pass = 4 total;
    // cumulative-dollar delta bills round(0.0032×1000)=3 total (correct). Driven
    // at the sweepLedgerBatch level so the two passes stay distinct (a single
    // tick would drain both — see the drain-loop tests below).
    await seedBillingCursor(0);
    for (let i = 0; i < 8; i++) {
      seedLlmUsage({ orgId, costUsd: 0.0004, source: "proxy", contextType: "chat", contextId: "sess-split" }); // prettier-ignore
    }

    await sweepLedgerBatch(4); // rows 1-4: cumulative $0.0016 → 2 credits
    expect(await creditsUsed()).toBe(2);
    await sweepLedgerBatch(4); // rows 5-8: cumulative $0.0032 → 3 credits (delta +1)

    expect(await creditsUsed()).toBe(3); // NOT 4

    const db = getEeDb();
    const [record] = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "sess-split"));
    expect(record!.costCredits).toBe(3);
    expect(Number(record!.costUsd)).toBeCloseTo(0.0032, 6); // cumulative dollars accumulate
  });

  it("rounds an exact half-credit cumulative half-away-from-zero (JS/SQL agree)", async () => {
    // An exact half-credit cumulative is the case where Postgres `round(double)`
    // (half to EVEN → 2) and `dollarsToCredits`/`round(numeric)` (half AWAY from
    // zero → 3) disagree. $0.0015 then $0.0010 for ONE context accumulate to
    // exactly $0.0025 → 2.5 credits, which must resolve to 3 (away from zero) and
    // leave ee_billing_accounts and ee_usage_records agreeing on 3.
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.0015, source: "proxy", contextType: "chat", contextId: "sess-half" }); // prettier-ignore
    await runBillingSweep(); // cumulative $0.0015 → round(1.5) = 2 credits
    expect(await creditsUsed()).toBe(2);

    seedLlmUsage({ orgId, costUsd: 0.001, source: "proxy", contextType: "chat", contextId: "sess-half" }); // prettier-ignore
    await runBillingSweep(); // cumulative $0.0025 → round(2.5) = 3 (away from zero), delta +1

    // Account debits sum to exactly 3, and the usage record agrees.
    expect(await creditsUsed()).toBe(3);
    const db = getEeDb();
    const [record] = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "sess-half"));
    expect(record!.costCredits).toBe(3);
    expect(Number(record!.costUsd)).toBeCloseTo(0.0025, 6);
  });

  it("rolls back the whole pass when the sweep transaction fails mid-flight", async () => {
    await seedBillingCursor(0);
    const id = seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1, would bill 50 credits

    // Force a failure INSIDE the transaction, after claims/debits/watermark but
    // before commit. Everything must revert atomically.
    await expect(
      sweepLedgerBatch(100, {
        onBeforeCommit: async () => {
          throw new Error("injected mid-transaction failure");
        },
      }),
    ).rejects.toThrow("injected mid-transaction failure");

    // Cursor unchanged, credits unchanged, and no claim persisted.
    expect(await cursorValue()).toBe(0);
    expect(await creditsUsed()).toBe(0);
    const db = getEeDb();
    const claims = await db
      .select()
      .from(eeBilledLlmUsage)
      .where(eq(eeBilledLlmUsage.llmUsageId, id));
    expect(claims).toHaveLength(0);
    const records = await db.select().from(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
    expect(records).toHaveLength(0);
  });
});

describe("billing cursor — init-time seed (cutover loss window)", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 20000 });
  });

  it("seeds an absent cursor at the settled frontier and reports it seeded", async () => {
    // Empty ledger at boot → frontier 0.
    const seed = await ensureCursorSeeded(mockPlatformServices, getEeDb());
    expect(seed).toEqual({ seeded: true, lastLlmUsageId: 0, floorId: 0 });
    expect(await cursorValue()).toBe(0);
  });

  it("records the seeded frontier as the cutover floor", async () => {
    // The floor keeps the replay window out of the excluded history, so it must be
    // written at seed time — not derived from a watermark that has since moved.
    seedLlmUsage({ orgId, costUsd: 0.25 });
    seedLlmUsage({ orgId, costUsd: 0.5 });

    const seed = await ensureCursorSeeded(mockPlatformServices, getEeDb());

    expect(seed).toEqual({ seeded: true, lastLlmUsageId: 2, floorId: 2 });
  });

  it("bills usage recorded AFTER the init seed but BEFORE the first sweep tick", async () => {
    // REGRESSION: previously the cursor was only seeded at the first sweep tick,
    // at THAT moment's frontier, so rows recorded between boot and the tick fell
    // below the initial watermark and were never billed. Seeding at init closes
    // the window: the first tick is a normal pass that bills these rows.
    await ensureCursorSeeded(mockPlatformServices, getEeDb()); // boot: frontier 0
    expect(await cursorValue()).toBe(0);

    // Usage recorded after boot, before the first tick.
    seedLlmUsage({ orgId, costUsd: 0.05 }); // id 1 → 50 credits
    seedLlmUsage({ orgId, costUsd: 0.1 }); // id 2 → 100 credits

    const result = await runBillingSweep();

    // Not a cutover (cursor already seeded) → the rows are billed, not skipped.
    expect(result.billed).toBe(2);
    expect(await creditsUsed()).toBe(150);
    expect(await cursorValue()).toBe(2);
  });

  it("is idempotent — a second call leaves an existing watermark untouched (no rewind)", async () => {
    await seedBillingCursor(7); // an already-advanced watermark
    const first = await ensureCursorSeeded(mockPlatformServices, getEeDb());
    expect(first).toEqual({ seeded: false, lastLlmUsageId: 7, floorId: 0 });
    expect(await cursorValue()).toBe(7);

    // Even with a higher frontier now available, a second call never reseeds or
    // rewinds — it is a pure no-op on an existing cursor.
    seedLlmUsage({ orgId, costUsd: 0.5 }); // would move the frontier if reseeded
    const second = await ensureCursorSeeded(mockPlatformServices, getEeDb());
    expect(second).toEqual({ seeded: false, lastLlmUsageId: 7, floorId: 0 });
    expect(await cursorValue()).toBe(7);
  });
});

describe("billing sweep — backlog drain within one tick", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "4";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 20000 });
  });

  it("drains a backlog larger than one batch within a single tick", async () => {
    await seedBillingCursor(0);
    // 2.5× batch size (10 rows), distinct contexts so each bills independently.
    for (let i = 0; i < 10; i++) seedLlmUsage({ orgId, costUsd: 0.01 }); // 10 credits each

    await runBillingSweep();

    // All 10 drained in ONE tick (batch 4 → passes of 4,4,2): cursor at the end,
    // every row billed. A single-batch-per-tick sweeper would have billed 4.
    expect(await cursorValue()).toBe(10);
    expect(await creditsUsed()).toBe(100);
  });

  it("drains the billable prefix then stops on a stalled head — one stall per tick", async () => {
    await seedBillingCursor(0);
    for (let i = 0; i < 4; i++) seedLlmUsage({ orgId, costUsd: 0.01 }); // ids 1-4 settled system
    seedLlmUsage({ orgId, costUsd: 0.1, credentialSource: "system", settled: false }); // id 5 wedged
    for (let i = 0; i < 3; i++) seedLlmUsage({ orgId, costUsd: 0.01 }); // ids 6-8 behind the stall

    const warnSpy = spyOn(logger, "warn");
    let last: SweepResult;
    let stallWarns: unknown[][];
    try {
      // Run STALL_LOG_EVERY (10) ticks so the periodic stall warn fires once.
      for (let i = 0; i < 10; i++) last = await runBillingSweep();
      stallWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("stalled"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    // The wedged system row (id 5) is the last pass's head-of-line stall, and it
    // counts ONCE per tick (not once per drained batch), so 10 ticks → 10 stalls
    // → the immediate first warn plus one throttled repeat at the 10th.
    expect(last!.stalledOnId).toBe(5);
    expect(stallWarns).toHaveLength(2);
    expect(stallWarns[0]![1]).toMatchObject({ blockingLlmUsageId: 5, consecutiveStalls: 1 });
    expect(stallWarns[1]![1]).toMatchObject({ blockingLlmUsageId: 5, consecutiveStalls: 10 });

    // First tick drained the billable prefix (ids 1-4); the wedge holds the rest.
    expect(await cursorValue()).toBe(4);
    expect(await creditsUsed()).toBe(40); // 4 × 10 credits
  });

  it("bounds a tick at the drain cap and rides the remainder onto the next tick", async () => {
    // batch 1, cap 50 → a tick drains at most 50 rows. Seed 60 settled rows.
    process.env.EE_RECONCILIATION_BATCH_SIZE = "1";
    _resetEeEnvForTests();
    await seedBillingCursor(0);
    for (let i = 0; i < 60; i++) seedLlmUsage({ orgId, costUsd: 0.01 });

    await runBillingSweep(); // capped at 50 iterations = 50 rows
    expect(await cursorValue()).toBe(50);

    await runBillingSweep(); // remaining 10
    expect(await cursorValue()).toBe(60);
    expect(await creditsUsed()).toBe(600); // all 60 eventually billed

    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
  });
});

describe("billing sweep — quota warning email", () => {
  const warnOrg = "00000000-0000-4000-a000-000000000060";
  const sentEmails: Array<{ to: string; subject: string }> = [];

  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    sentEmails.length = 0;
    initBillingEmail({
      sendMail: async (to, subject) => {
        sentEmails.push({ to, subject });
      },
      getRecipients: async () => ["billing@test.com"],
      getOrgName: async () => null,
    });
  });

  it("fires once when a debit crosses the 80% threshold", async () => {
    await seedBillingAccount({
      orgId: warnOrg,
      planId: "starter",
      creditsUsed: 15800, // 79%
      creditQuota: 20000,
    });
    await seedBillingCursor(0);
    seedLlmUsage({ orgId: warnOrg, costUsd: 0.3 }); // +300 → 16100 = 80.5%

    await runBillingSweep();
    await new Promise((r) => setTimeout(r, 100));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe("billing@test.com");
  });

  it("does not fire when already above the threshold", async () => {
    await seedBillingAccount({
      orgId: warnOrg,
      planId: "starter",
      creditsUsed: 17000, // 85%
      creditQuota: 20000,
    });
    await seedBillingCursor(0);
    seedLlmUsage({ orgId: warnOrg, costUsd: 0.1 });

    await runBillingSweep();
    await new Promise((r) => setTimeout(r, 100));

    expect(sentEmails).toHaveLength(0);
  });
});

/**
 * TRUE concurrency: two sweep transactions racing on the same backlog, in the
 * same process, via `Promise.all`.
 *
 * The previous "concurrency" coverage drove a hook that ran BEFORE the
 * transaction opened, so there were never two open transactions, never two
 * `ON CONFLICT` inserts contending, and never two `UPDATE credits_used` on the
 * same row. These cases exercise the real interleaving the production
 * guarantees rest on: the PK on `ee_billed_llm_usage.llm_usage_id`, the
 * `ON CONFLICT DO NOTHING RETURNING` claim, and the monotonic watermark.
 */
describe("billing sweep — real concurrent passes", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 2_000_000 });
  });

  async function claimCount(): Promise<number> {
    const db = getEeDb();
    return (await db.select().from(eeBilledLlmUsage)).length;
  }

  it("bills each row exactly once when two passes race on the same backlog", async () => {
    await seedBillingCursor(0);
    // Distinct contexts: the contended resources are the claim rows, the account
    // row and the cursor row.
    for (let i = 0; i < 20; i++) seedLlmUsage({ orgId, costUsd: 0.01, contextId: `run-${i}` });

    const [a, b] = await Promise.all([sweepLedgerBatch(100), sweepLedgerBatch(100)]);

    // Every row claimed once, across both passes combined.
    expect(a.billed + b.billed).toBe(20);
    expect(await claimCount()).toBe(20);
    // 20 × $0.01 = 200 credits — NOT 400.
    expect(await creditsUsed()).toBe(200);
    expect(await cursorValue()).toBe(20);
  });

  it("bills a shared context exactly once when two passes race", async () => {
    // Same (context_type, context_id) for every row: both passes contend on ONE
    // `ee_usage_records` row, so a lost claim that still accumulated dollars
    // would double the cumulative and double the debit.
    await seedBillingCursor(0);
    for (let i = 0; i < 20; i++) {
      seedLlmUsage({ orgId, costUsd: 0.01, source: "proxy", contextType: "chat", contextId: "sess-race" }); // prettier-ignore
    }

    await Promise.all([sweepLedgerBatch(100), sweepLedgerBatch(100)]);

    const db = getEeDb();
    const records = await db
      .select()
      .from(orgUsageRecords)
      .where(eq(orgUsageRecords.contextId, "sess-race"));
    expect(records).toHaveLength(1);
    expect(Number(records[0]!.costUsd)).toBeCloseTo(0.2, 9);
    expect(records[0]!.costCredits).toBe(200);
    expect(await creditsUsed()).toBe(200);
    expect(await claimCount()).toBe(20);
  });

  it("never rewinds the watermark when a lagging pass races an advanced one", async () => {
    await seedBillingCursor(0);
    for (let i = 0; i < 6; i++) seedLlmUsage({ orgId, costUsd: 0.01, contextId: `run-${i}` });

    // Pass A takes a small batch (frontier ends at id 2), pass B takes the whole
    // backlog (frontier ends at id 6). Whichever commits last, GREATEST keeps 6.
    await Promise.all([sweepLedgerBatch(2), sweepLedgerBatch(100)]);

    expect(await cursorValue()).toBe(6);
    expect(await creditsUsed()).toBe(60); // 6 × 10 credits, once each
    expect(await claimCount()).toBe(6);
  });
});

/**
 * Serial-`id` visibility replay window.
 *
 * A PostgreSQL `serial` value is assigned at INSERT and published at COMMIT, and
 * those two orders are not the same: the transaction holding id 100 can commit
 * AFTER the one holding id 101. A pass landing in that window bills 101 and
 * advances the watermark past 100 — and a `WHERE id > watermark` cursor can then
 * never return row 100 again. It is never billed, and nothing logs it.
 *
 * Every case below models that interleaving the way EE actually experiences
 * it: the ledger lives behind `PlatformServices.usage.list`, so "a row committed
 * late" IS "a row `usage.list` did not return before and returns now". The EE
 * side — cursor, claims, usage records, account debits — is the real database.
 */
describe("billing sweep — serial-visibility replay window", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    process.env.EE_RECONCILIATION_REPLAY_WINDOW = "200";
    _resetEeEnvForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 2_000_000 });
  });

  it("bills a row that becomes visible BELOW an already-advanced watermark", async () => {
    // THE BUG. Transaction for id 2 takes its serial value first but commits
    // last, so this pass sees only 1 and 3.
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, id: 1, contextId: "run-1" }); // 50 credits
    seedLlmUsage({ orgId, costUsd: 0.07, id: 3, contextId: "run-3" }); // 70 credits

    const first = await runBillingSweep();
    expect(first.billed).toBe(2);
    expect(await cursorValue()).toBe(3); // watermark is now PAST the missing id 2
    expect(await creditsUsed()).toBe(120);

    // id 2's transaction finally commits. It is below the watermark, so a plain
    // `WHERE id > 3` cursor would never see it again — this is the row that was
    // silently lost in production.
    seedLlmUsage({ orgId, costUsd: 0.09, id: 2, contextId: "run-2" }); // 90 credits

    const second = await runBillingSweep();

    // Caught by the replay window and billed.
    expect(second.replayBilled).toBe(1);
    expect(second.billed).toBe(1);
    expect(await creditsUsed()).toBe(210); // 120 + 90 — nothing lost
    const db = getEeDb();
    const claims = await db
      .select()
      .from(eeBilledLlmUsage)
      .where(eq(eeBilledLlmUsage.llmUsageId, 2));
    expect(claims).toHaveLength(1);
    // The window is a READ offset: the watermark did not move to reach id 2.
    expect(await cursorValue()).toBe(3);
  });

  it("REGRESSION: the same row is lost forever with the replay window disabled", async () => {
    // The negative of the case above — this is what the code did before the
    // window existed, and what `REPLAY_WINDOW=0` still opts back into. It pins
    // WHY the window is not redundant work: delete the replay and this is the
    // behaviour you get back, silently.
    process.env.EE_RECONCILIATION_REPLAY_WINDOW = "0";
    _resetEeEnvForTests();

    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, id: 1, contextId: "run-1" });
    seedLlmUsage({ orgId, costUsd: 0.07, id: 3, contextId: "run-3" });
    await runBillingSweep();
    expect(await creditsUsed()).toBe(120);

    seedLlmUsage({ orgId, costUsd: 0.09, id: 2, contextId: "run-2" });
    const second = await runBillingSweep();

    // Never read, never billed, never logged.
    expect(second.replayed).toBe(0);
    expect(second.billed).toBe(0);
    expect(await creditsUsed()).toBe(120); // the $0.09 is gone
    expect(await claimedIds()).toEqual([1, 3]);
  });

  it("re-reads claimed rows every pass and debits nothing for them", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-a" });
    seedLlmUsage({ orgId, costUsd: 0.1, contextId: "run-b" });

    await runBillingSweep();
    expect(await creditsUsed()).toBe(150);

    // Nothing new in the ledger: this pass re-reads only already-claimed rows.
    const second = await runBillingSweep();

    expect(second.replayed).toBe(2); // the window did scan them
    expect(second.replayBilled).toBe(0); // and correctly found nothing owed
    expect(second.billed).toBe(0);
    expect(await creditsUsed()).toBe(150); // no double debit
    expect(await claimCount()).toBe(2);
  });

  it("does not report replayed rows as an abnormal re-sweep", async () => {
    // `alreadyBilled` warns that the cursor was re-seeded or two sweepers
    // overlap. Counting the replay window in it would make that warning fire on
    // EVERY tick — a money-path alarm that always fires is worse than none.
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-a" });
    await runBillingSweep();

    const warnSpy = spyOn(logger, "warn");
    let reReadWarns: unknown[][];
    let second: SweepResult;
    try {
      second = await runBillingSweep();
      reReadWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("already-claimed"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(second.replayed).toBe(1);
    expect(second.alreadyBilled).toBe(0);
    expect(reReadWarns).toHaveLength(0);
  });

  it("warns when the replay window actually catches a row", async () => {
    // The proof the race is live in a deployment. Loud enough for an operator to
    // notice revenue was recovered, at `warn` rather than `error` because the
    // system did the right thing.
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, id: 1, contextId: "run-1" });
    seedLlmUsage({ orgId, costUsd: 0.05, id: 3, contextId: "run-3" });
    await runBillingSweep();

    seedLlmUsage({ orgId, costUsd: 0.09, id: 2, contextId: "run-2" });

    const warnSpy = spyOn(logger, "warn");
    let replayWarns: unknown[][];
    try {
      await runBillingSweep();
      replayWarns = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("BELOW the watermark"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(replayWarns).toHaveLength(1);
    expect(replayWarns[0]![1]).toMatchObject({ replayBilled: 1, replayWindow: 200 });
  });

  it("never rewinds the watermark when the frontier ends inside the replay window", async () => {
    // A late-committing row can also be an UNSETTLED system row (a runner row
    // whose run is still going). It stalls the frontier from BELOW the
    // watermark — structurally impossible before the replay window, since such a
    // row was simply never read again. Billing pauses for EVERY tenant until it
    // settles (`billed` is 0 here), and that is the accepted trade: the stall is
    // what pins the watermark so the row cannot age out of the replay window and
    // be lost. A visible fleet-wide delay in exchange for an impossible loss.
    // What must NOT happen is the cursor being dragged back.
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, id: 1, contextId: "run-1" });
    seedLlmUsage({ orgId, costUsd: 0.05, id: 3, contextId: "run-3" });
    await runBillingSweep();
    expect(await cursorValue()).toBe(3);

    // id 2 commits late AND is still in flight.
    seedLlmUsage({ orgId, costUsd: 0.09, id: 2, contextId: "run-2", settled: false });

    const stalled = await runBillingSweep();
    expect(stalled.stalledOnId).toBe(2); // waiting on it, not skipping it
    expect(stalled.billed).toBe(0);
    expect(stalled.cursorTo).toBe(3);
    expect(await cursorValue()).toBe(3); // NOT rewound to 1

    // Once the run reaches a terminal status the row settles and is billed.
    mockLedger.find((r) => r.id === 2)!.settled = true;
    const drained = await runBillingSweep();
    expect(drained.replayBilled).toBe(1);
    expect(await creditsUsed()).toBe(190); // 50 + 50 + 90
    expect(await cursorValue()).toBe(3); // still monotonic, still 3
  });

  it("distinguishes a stall BELOW the watermark from one at the frontier", async () => {
    // Both stalls block billing for every tenant, but the operator response
    // differs: at the frontier it is an ordinary in-flight run, while below the
    // watermark it is a late-committing row replay recovered and is deliberately
    // being waited on. The blocking id alone cannot tell them apart.
    const stallFields = async (): Promise<Record<string, unknown>> => {
      _resetBillingSweeperForTests(); // consecutiveStalls → 0, so the FIRST-stall warn fires
      const warnSpy = spyOn(logger, "warn");
      try {
        await runBillingSweep();
        const stallWarns = warnSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string" && msg.includes("stalled on an unsettled"),
        );
        expect(stallWarns).toHaveLength(1);
        return stallWarns[0]![1] as Record<string, unknown>;
      } finally {
        warnSpy.mockRestore();
      }
    };

    // (a) Frontier stall: an in-flight run sitting just above the watermark.
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.1, id: 1, contextId: "run-1", settled: false });
    expect(await stallFields()).toMatchObject({
      blockingLlmUsageId: 1,
      stalledBelowWatermark: false,
    });

    // (b) Below-watermark stall: rows 10 and 12 bill and carry the watermark to
    //     12, then row 11 commits late and is still in flight.
    await truncateEeTables();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 2_000_000 });
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, id: 10, contextId: "run-10" });
    seedLlmUsage({ orgId, costUsd: 0.05, id: 12, contextId: "run-12" });
    await runBillingSweep();
    expect(await cursorValue()).toBe(12);
    seedLlmUsage({ orgId, costUsd: 0.09, id: 11, contextId: "run-11", settled: false });

    expect(await stallFields()).toMatchObject({
      blockingLlmUsageId: 11,
      stalledBelowWatermark: true,
      cursorAt: 12, // the stall is anchored UNDER the watermark
    });
  });

  it("clamps the scan at 0 instead of underflowing on a fresh cursor", async () => {
    // A cursor below the replay window (a brand-new deployment) must not ask the
    // platform for a negative `afterId`.
    await seedBillingCursor(5);
    const listSpy = spyOn(mockPlatformServices.usage, "list");
    let firstRead: unknown;
    try {
      await runBillingSweep();
      // Read the recorded args BEFORE restoring — `mockRestore()` clears them.
      firstRead = listSpy.mock.calls[0]![0];
    } finally {
      listSpy.mockRestore();
    }

    // 5 − 200 clamps to 0, not −195.
    expect(firstRead).toMatchObject({ afterId: 0 });
  });

  it("keeps the cutover seed billing nothing and reading nothing below it", async () => {
    // At cutover `ensureCursorSeeded` places the watermark at the settled
    // frontier and the pass returns immediately. The replay window must not
    // reach back below that seed and retro-bill history.
    seedLlmUsage({ orgId, costUsd: 0.25, contextId: "run-old" });
    seedLlmUsage({ orgId, costUsd: 0.5, contextId: "run-older" });

    const result = await runBillingSweep();

    expect(result.cursorTo).toBe(2);
    expect(result.replayed).toBe(0);
    expect(result.billed).toBe(0);
    expect(await creditsUsed()).toBe(0);
    expect(await claimCount()).toBe(0);
  });

  it("gives the forward batch its full size on top of the replay window", async () => {
    // The window is read IN ADDITION to the batch, never out of it — otherwise
    // every pass would lose `REPLAY_WINDOW` rows of forward throughput, and a
    // window at or above the batch size would stall the sweeper outright.
    process.env.EE_RECONCILIATION_REPLAY_WINDOW = "10";
    _resetEeEnvForTests();
    await seedBillingCursor(0);
    for (let i = 0; i < 9; i++) seedLlmUsage({ orgId, costUsd: 0.01, contextId: `run-${i}` });

    const first = await sweepLedgerBatch(3);
    expect(first.processed).toBe(3); // batch respected, replay region empty
    expect(await cursorValue()).toBe(3);

    // Watermark 3, window 10 → scans from 0 and re-reads ids 1-3, but the
    // FORWARD slice is still a full batch of 3.
    const second = await sweepLedgerBatch(3);
    expect(second.replayed).toBe(3);
    expect(second.processed).toBe(3);
    expect(second.replayBilled).toBe(0);
    expect(await cursorValue()).toBe(6);
  });

  it("does not spin the drain loop when a pass advances nothing", async () => {
    // The drain loop continues while a pass filled its batch. Replayed rows are
    // excluded from `processed` and the loop also requires cursor progress, so a
    // caught-up ledger cannot loop to the iteration cap on every tick.
    _resetBillingSweeperForTests();
    await seedBillingCursor(0);
    for (let i = 0; i < 3; i++) seedLlmUsage({ orgId, costUsd: 0.01, contextId: `run-${i}` });
    await runBillingSweep();

    const infoSpy = spyOn(logger, "info");
    try {
      await runBillingSweep();
      const ticks = infoSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("tick complete"),
      );
      expect(ticks).toHaveLength(1);
      expect(ticks[0]![1]).toMatchObject({ iterations: 1, processed: 0, replayed: 3 });
    } finally {
      infoSpy.mockRestore();
    }
  });

  async function claimCount(): Promise<number> {
    const db = getEeDb();
    return (await db.select().from(eeBilledLlmUsage)).length;
  }

  async function claimedIds(): Promise<number[]> {
    const db = getEeDb();
    const rows = await db.select({ id: eeBilledLlmUsage.llmUsageId }).from(eeBilledLlmUsage);
    return rows.map((r) => r.id).sort((a, b) => a - b);
  }
});

describe("billing sweep — cutover exclusion floor", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    process.env.EE_RECONCILIATION_REPLAY_WINDOW = "200";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 2_000_000 });
  });

  it("REGRESSION: historical usage stays excluded on the SECOND sweep too", async () => {
    // The cutover promise is "rows below the seeded frontier are never revisited".
    // Without the floor the second pass reads from `watermark − REPLAY_WINDOW`, walks
    // back under the seed and bills the whole excluded history.
    seedLlmUsage({ orgId, costUsd: 0.25, contextId: "run-old" });
    seedLlmUsage({ orgId, costUsd: 0.5, contextId: "run-older" });

    const seeding = await runBillingSweep();
    expect(seeding.cursorTo).toBe(2);
    expect(await creditsUsed()).toBe(0);

    const second = await runBillingSweep();
    expect(second.replayed).toBe(0);
    expect(second.billed).toBe(0);
    expect(await creditsUsed()).toBe(0);
    expect(await claimCount()).toBe(0);
  });

  it("still replays a row that commits late ABOVE the floor", async () => {
    // The floor bounds the replay window, it does not disable it: a row that took a low
    // id before the watermark passed but committed after must still be caught.
    seedLlmUsage({ orgId, costUsd: 0.25, id: 1, contextId: "run-old" });
    seedLlmUsage({ orgId, costUsd: 0.5, id: 2, contextId: "run-older" });
    await runBillingSweep(); // seeds watermark AND floor at 2

    seedLlmUsage({ orgId, costUsd: 0.04, id: 4, contextId: "run-4" }); // 40 credits
    await runBillingSweep();
    expect(await cursorValue()).toBe(4);
    expect(await creditsUsed()).toBe(40);

    // id 3 finally commits: below the watermark, above the floor.
    seedLlmUsage({ orgId, costUsd: 0.06, id: 3, contextId: "run-3" }); // 60 credits
    const third = await runBillingSweep();

    expect(third.replayBilled).toBe(1);
    expect(await creditsUsed()).toBe(100);
    expect(await claimedIds()).toEqual([3, 4]); // 1 and 2 stay excluded
  });

  async function claimCount(): Promise<number> {
    const db = getEeDb();
    return (await db.select().from(eeBilledLlmUsage)).length;
  }

  async function claimedIds(): Promise<number[]> {
    const db = getEeDb();
    const rows = await db.select({ id: eeBilledLlmUsage.llmUsageId }).from(eeBilledLlmUsage);
    return rows.map((r) => r.id).sort((a, b) => a - b);
  }
});

describe("billing sweep — rows the platform could not price", () => {
  const otherOrgId = "00000000-0000-4000-a000-000000000011";

  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    process.env.EE_RECONCILIATION_REPLAY_WINDOW = "200";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 2_000_000 });
    await seedBillingAccount({ orgId: otherOrgId, creditsUsed: 0, creditQuota: 2_000_000 });
    await seedBillingCursor(0, 0);
  });

  async function claimStamp(llmUsageId: number): Promise<string> {
    const db = getEeDb();
    const [row] = await db
      .select({ pricingStatus: eeBilledLlmUsage.pricingStatus })
      .from(eeBilledLlmUsage)
      .where(eq(eeBilledLlmUsage.llmUsageId, llmUsageId));
    return row!.pricingStatus;
  }

  it("bills a `partial` row on its floor and stamps the claim", async () => {
    const id = seedLlmUsage({ orgId, costUsd: 0.05, pricingStatus: "partial" });

    const result = await runBillingSweep();

    expect(await creditsUsed()).toBe(50); // the floor IS charged
    expect(await claimStamp(id)).toBe("partial");
    expect(result.pricing).toMatchObject({ partial: 1, unpriced: 0, unknown: 0 });
  });

  it("claims an `unpriced` row for 0 credits instead of settling it as free", async () => {
    // cost 0 + `unpriced` means "could not price this call", NOT "free": claiming it
    // stops a double bill, the stamp keeps the uncollected revenue findable.
    const id = seedLlmUsage({ orgId, costUsd: 0, pricingStatus: "unpriced" });

    const result = await runBillingSweep();

    expect(await creditsUsed()).toBe(0);
    expect(await claimStamp(id)).toBe("unpriced");
    expect(result.billed).toBe(1);
    expect(result.pricing).toMatchObject({ unpriced: 1, orgIds: [orgId] });
  });

  it("never reads a null pricing status as priced", async () => {
    // A row predating the field: claimed at 0 credits and stamped `unknown`, a
    // different fact from `unpriced` that an operator diagnoses differently.
    const id = seedLlmUsage({ orgId, costUsd: 0.05, pricingStatus: null });

    const result = await runBillingSweep();

    expect(await creditsUsed()).toBe(0);
    expect(await claimStamp(id)).toBe("unknown");
    expect(result.pricing).toMatchObject({ unknown: 1 });
  });

  it("emits ONE error line per pass naming every affected org", async () => {
    seedLlmUsage({ orgId, costUsd: 0.05, pricingStatus: "partial" });
    seedLlmUsage({ orgId, costUsd: 0, pricingStatus: "unpriced" });
    seedLlmUsage({ orgId: otherOrgId, costUsd: 0.05, pricingStatus: null });
    seedLlmUsage({ orgId, costUsd: 0.05 }); // priced — never in the report

    const errorSpy = spyOn(logger, "error");
    try {
      await runBillingSweep();
      const faults = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("could not price in full"),
      );
      expect(faults).toHaveLength(1);
      expect(faults[0]![1]).toMatchObject({ partial: 1, unpriced: 1, unknown: 1 });
      expect((faults[0]![1] as { orgIds: string[] }).orgIds.sort()).toEqual(
        [orgId, otherOrgId].sort(),
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(await creditsUsed()).toBe(100); // partial + priced only
    expect(await creditsUsed(otherOrgId)).toBe(0);
  });

  it("stays silent when every row is priced", async () => {
    seedLlmUsage({ orgId, costUsd: 0.05 });

    const errorSpy = spyOn(logger, "error");
    try {
      const result = await runBillingSweep();
      expect(result.pricing).toMatchObject({ partial: 0, unpriced: 0, unknown: 0, orgIds: [] });
      expect(
        errorSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string" && msg.includes("could not price in full"),
        ),
      ).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
