// SPDX-License-Identifier: Apache-2.0

/**
 * `recordLlmUsage` — the single writer of the append-only `llm_usage` ledger
 * (`services/llm-usage-ledger.ts`). Every producer (inference proxy, agent
 * runner sink, subscription chat) inserts through it, so this locks down the
 * two behaviours they all rely on:
 *
 *   1. the plain insert (proxy / chat) — returns the new serial id;
 *   2. the runner's two-level monotonic upsert against
 *      `uq_llm_usage_runner_run_id` — a higher cumulative cost wins, or an equal
 *      cost with a higher token total (so a zero-cost model still advances), a
 *      regressing write is a no-op that returns null, an exact duplicate re-emits
 *      nothing, and the token columns move with the snapshot.
 *
 * The DB check constraint that forbids a row carrying BOTH a run and a chat
 * session (`llm_usage_context_single`) is asserted here too.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { recordLlmUsage } from "../../../src/services/llm-usage-ledger.ts";
import type { TokenPricingStatus } from "@appstrate/afps-runtime/runner";
import { llmUsage, chatSessions } from "@appstrate/db/schema";

/** Row read-back helper: the full stored row for a ledger id. */
async function rowById(id: number) {
  const [row] = await db.select().from(llmUsage).where(eq(llmUsage.id, id));
  return row;
}

describe("recordLlmUsage — plain insert (proxy / chat)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ledgerwriter" });
  });

  it("appends a proxy row and returns its serial id, mapping every column", async () => {
    const id = await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      model: "preset-x",
      realModel: "gpt-4o-2024-08-06",
      api: "openai-completions",
      credentialSource: "org",
      inputTokens: 100,
      outputTokens: 42,
      cacheReadTokens: 30,
      cacheWriteTokens: 7,
      costUsd: 0.00113,
      pricingStatus: "priced" as const,
      durationMs: 850,
      requestId: "req_ledger_plain",
    });

    expect(typeof id).toBe("number");
    const row = await rowById(id!);
    expect(row).toBeDefined();
    expect(row!.source).toBe("proxy");
    expect(row!.orgId).toBe(ctx.orgId);
    expect(row!.userId).toBe(ctx.user.id);
    expect(row!.model).toBe("preset-x");
    expect(row!.realModel).toBe("gpt-4o-2024-08-06");
    expect(row!.api).toBe("openai-completions");
    expect(row!.credentialSource).toBe("org");
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(42);
    expect(row!.cacheReadTokens).toBe(30);
    expect(row!.cacheWriteTokens).toBe(7);
    expect(row!.costUsd).toBeCloseTo(0.00113, 6);
    expect(row!.pricingStatus).toBe("priced");
    expect(row!.durationMs).toBe(850);
    expect(row!.requestId).toBe("req_ledger_plain");
    // Plain insert never carries run/chat attribution unless asked.
    expect(row!.runId).toBeNull();
    expect(row!.chatSessionId).toBeNull();
  });

  it("stamps chat-session attribution when chatSessionId is set", async () => {
    await db.insert(chatSessions).values({
      id: "chs_ledger_1",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
    });
    const id = await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      chatSessionId: "chs_ledger_1",
      credentialSource: "org",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
      pricingStatus: "priced" as const,
      requestId: "req_ledger_chat",
    });
    const row = await rowById(id!);
    expect(row!.chatSessionId).toBe("chs_ledger_1");
    expect(row!.runId).toBeNull();
  });

  it("replays a proxy retry idempotently when request_id already committed", async () => {
    const entry = {
      source: "proxy" as const,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      credentialSource: "system" as const,
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0.002,
      pricingStatus: "priced" as const,
      requestId: "req_durable_retry",
    };

    const first = await recordLlmUsage(entry, { onConflict: "proxy-idempotent" });
    const replay = await recordLlmUsage(entry, { onConflict: "proxy-idempotent" });

    expect(typeof first).toBe("number");
    expect(replay).toBeNull();
    const rows = await db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.requestId, "req_durable_retry"));
    expect(rows).toHaveLength(1);
  });

  it("rejects a row attributed to BOTH a run and a chat session (llm_usage_context_single)", async () => {
    await seedAgent({ id: "@ledgerwriter/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    const run = await seedRun({
      packageId: "@ledgerwriter/agent",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: "success",
    });
    await db.insert(chatSessions).values({
      id: "chs_ledger_both",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
    });

    // Positive controls: EACH context alone is a valid row (both FKs are
    // satisfiable), so a rejection of the both-set row can only come from the
    // single-context check constraint, not a bad foreign key.
    const runOnly = await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "org",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.0001,
      pricingStatus: "priced" as const,
      requestId: "req_ledger_run_only",
    });
    expect(typeof runOnly).toBe("number");
    const chatOnly = await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      chatSessionId: "chs_ledger_both",
      credentialSource: "org",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.0001,
      pricingStatus: "priced" as const,
      requestId: "req_ledger_chat_only",
    });
    expect(typeof chatOnly).toBe("number");

    // A single row pinned to BOTH a run and a chat session is refused by the
    // `llm_usage_context_single` check constraint — never silently stored.
    let error: unknown;
    try {
      await recordLlmUsage({
        source: "proxy",
        orgId: ctx.orgId,
        runId: run.id,
        chatSessionId: "chs_ledger_both",
        credentialSource: "org",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.0001,
        pricingStatus: "priced" as const,
        requestId: "req_ledger_both",
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    // The violation surfaces the constraint name somewhere in the error chain
    // (message or cause) regardless of the driver's wrapping.
    const cause = (error as { cause?: { message?: string; constraint?: string } }).cause;
    const text = `${(error as Error).message} ${cause?.message ?? ""} ${cause?.constraint ?? ""}`;
    expect(text).toContain("context_single");
  });
});

describe("recordLlmUsage — runner birth invariant", () => {
  it("rejects a runner entry without a runId (guard replaces the dropped DB CHECK)", async () => {
    // Since migration 0028 the DB can no longer forbid NULL run_id on runner
    // rows (detach legitimately NULLs it); the writer is the sole guarantor. A
    // runner row born without a run would dodge the monotonic partial unique
    // index and turn every cumulative snapshot into a fresh settled row.
    await expect(
      recordLlmUsage({
        source: "runner",
        orgId: "00000000-0000-4000-a000-000000000001",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        pricingStatus: "priced" as const,
      }),
    ).rejects.toThrow("a runner row must be born with a runId");
  });
});

describe("recordLlmUsage — runner monotonic upsert", () => {
  let ctx: TestContext;
  let runId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ledgerrunner" });
    await seedAgent({ id: "@ledgerrunner/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    const run = await seedRun({
      packageId: "@ledgerrunner/agent",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: "running",
    });
    runId = run.id;
  });

  function runnerEntry(
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    pricingStatus: TokenPricingStatus | null = "priced",
  ) {
    return {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId,
      credentialSource: "system" as const,
      inputTokens,
      outputTokens,
      costUsd,
      pricingStatus,
    };
  }

  it("keeps a single row per run: a higher cumulative cost wins and bumps the token columns", async () => {
    const id1 = await recordLlmUsage(runnerEntry(0.1, 100, 50), {
      onConflict: "runner-monotonic",
    });
    expect(typeof id1).toBe("number");

    // A later metric event carrying a larger cumulative total updates the SAME
    // row (single row per run) — id unchanged, cost + tokens moved up.
    const id2 = await recordLlmUsage(runnerEntry(0.5, 200, 100), {
      onConflict: "runner-monotonic",
    });
    expect(id2).toBe(id1);

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0.5, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);

    // Only one runner row exists for the run.
    const all = await db.select().from(llmUsage).where(eq(llmUsage.runId, runId));
    expect(all).toHaveLength(1);
  });

  it("a regressing (lower) cost is a no-op that returns null and never lowers the recorded total", async () => {
    const id1 = await recordLlmUsage(runnerEntry(0.5, 200, 100), {
      onConflict: "runner-monotonic",
    });

    // Out-of-order / stale event with a smaller total must NOT regress the bill.
    const lost = await recordLlmUsage(runnerEntry(0.3, 1, 1), {
      onConflict: "runner-monotonic",
    });
    expect(lost).toBeNull();

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0.5, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);
  });

  it("zero-cost runner row: an equal cost with a higher token total still advances", async () => {
    // A free / zero-rate model pins cost at 0 on every cumulative metric event,
    // so a cost-only rule would freeze the token columns at their first values.
    const id1 = await recordLlmUsage(
      { ...runnerEntry(0, 100, 50), cacheReadTokens: 10, cacheWriteTokens: 5 },
      { onConflict: "runner-monotonic" },
    );
    expect(typeof id1).toBe("number");

    const id2 = await recordLlmUsage(
      { ...runnerEntry(0, 200, 100), cacheReadTokens: 20, cacheWriteTokens: 10 },
      { onConflict: "runner-monotonic" },
    );
    expect(id2).toBe(id1);

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);
    expect(row!.cacheReadTokens).toBe(20);
    expect(row!.cacheWriteTokens).toBe(10);
  });

  it("an exact duplicate (same cost AND same tokens) is a no-op that changes nothing", async () => {
    const entry = runnerEntry(0.5, 200, 100);
    const id1 = await recordLlmUsage(entry, { onConflict: "runner-monotonic" });
    expect(typeof id1).toBe("number");

    // Replaying the identical cumulative snapshot must change nothing — the
    // idempotence cursor consumers rely on (strict inequalities on both cost
    // and the token tiebreak).
    const dup = await recordLlmUsage(entry, { onConflict: "runner-monotonic" });
    expect(dup).toBeNull();

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0.5, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);
  });

  it("carries the WINNING snapshot's pricing status onto the row", async () => {
    // The status describes the numbers now stored, so it travels with the
    // snapshot that won — a row must never claim `priced` over token counts a
    // differently-classified snapshot brought in.
    const id1 = await recordLlmUsage(runnerEntry(0, 100, 50, "unpriced"), {
      onConflict: "runner-monotonic",
    });
    expect((await rowById(id1!))!.pricingStatus).toBe("unpriced");

    const id2 = await recordLlmUsage(runnerEntry(0.4, 200, 100, "priced"), {
      onConflict: "runner-monotonic",
    });
    expect(id2).toBe(id1);
    expect((await rowById(id1!))!.pricingStatus).toBe("priced");
  });

  it("a refused (regressing) snapshot cannot rewrite the stored pricing status", async () => {
    const id1 = await recordLlmUsage(runnerEntry(0.5, 200, 100, "priced"), {
      onConflict: "runner-monotonic",
    });
    const lost = await recordLlmUsage(runnerEntry(0.1, 1, 1, "unpriced"), {
      onConflict: "runner-monotonic",
    });
    expect(lost).toBeNull();
    expect((await rowById(id1!))!.pricingStatus).toBe("priced");
  });

  it("persists a null status verbatim — 'not this platform's fact to state' is not 'priced'", async () => {
    // The remote-run shape: `runs.model_source` is NULL, so no platform-side
    // pricing verdict exists for the row (see `writeRunnerLedgerRow`).
    const id = await recordLlmUsage(runnerEntry(0.2, 10, 10, null), {
      onConflict: "runner-monotonic",
    });
    expect((await rowById(id!))!.pricingStatus).toBeNull();
  });
});
