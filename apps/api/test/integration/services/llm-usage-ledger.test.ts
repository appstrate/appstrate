// SPDX-License-Identifier: Apache-2.0

/**
 * `recordLlmUsage` — the single writer of the append-only `llm_usage` ledger
 * (`services/llm-usage-ledger.ts`). Every producer (inference proxy, agent
 * runner sink, subscription chat) inserts through it, so this locks down the
 * three behaviours they all rely on:
 *
 *   1. the plain insert (proxy / chat) — returns the new serial id;
 *   2. the runner's two-level monotonic upsert against
 *      `uq_llm_usage_runner_run_id` — a higher cumulative cost wins, or an equal
 *      cost with a higher token total (so a zero-cost model still advances), a
 *      regressing write is a no-op that returns null, an exact duplicate re-emits
 *      nothing, and the token columns move with the snapshot;
 *   3. the `onUsageRecorded` broadcast — correct context/credential derivation,
 *      never the server-side-only `real_model` / `api`, and no event when the
 *      monotonic upsert did not write.
 *
 * The DB check constraint that forbids a row carrying BOTH a run and a chat
 * session (`llm_usage_context_single`) is asserted here too.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { recordLlmUsage } from "../../../src/services/llm-usage-ledger.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type {
  AppstrateModule,
  ModuleInitContext,
  UsageRecordedParams,
} from "@appstrate/core/module";
import { llmUsage, chatSessions } from "@appstrate/db/schema";

/** Minimal init context — the fake module only needs its event handler invoked. */
function fakeInitCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

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
      requestId: "req_ledger_chat",
    });
    const row = await rowById(id!);
    expect(row!.chatSessionId).toBe("chs_ledger_1");
    expect(row!.runId).toBeNull();
  });

  it("rejects a row attributed to BOTH a run and a chat session (llm_usage_context_single)", async () => {
    await seedAgent({ id: "@ledgerwriter/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    const run = await seedRun({
      packageId: "@ledgerwriter/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(chatSessions).values({
      id: "chs_ledger_both",
      orgId: ctx.orgId,
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
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    runId = run.id;
  });

  function runnerEntry(costUsd: number, inputTokens: number, outputTokens: number) {
    return {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId,
      credentialSource: "system" as const,
      inputTokens,
      outputTokens,
      costUsd,
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
});

describe("recordLlmUsage — onUsageRecorded broadcast", () => {
  let ctx: TestContext;
  const events: UsageRecordedParams[] = [];

  const observer: AppstrateModule = {
    manifest: { id: "test-usage-observer", name: "Usage observer", version: "0.0.0" },
    async init() {},
    events: {
      onUsageRecorded: (params) => {
        events.push(params);
      },
    },
  };

  beforeEach(async () => {
    await truncateAll();
    events.length = 0;
    resetModules();
    await loadModulesFromInstances([observer], fakeInitCtx());
    ctx = await createTestContext({ orgSlug: "ledgerevent" });
    await seedAgent({ id: "@ledgerevent/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  afterEach(() => {
    resetModules();
  });

  // The producer void()s the emit (fire-and-forget) — flush the microtask/timer
  // queue so the synchronous handler has certainly run before asserting.
  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
  }

  it("emits with run context + credentialSource, and NEVER the server-side real_model/api", async () => {
    const run = await seedRun({
      packageId: "@ledgerevent/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    const id = await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      runId: run.id,
      model: "appstrate-medium",
      realModel: "deepseek-chat-SECRET",
      api: "openai-completions",
      credentialSource: "system",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      requestId: "req_event_run",
    });
    await flush();

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.llmUsageId).toBe(id!);
    expect(ev.orgId).toBe(ctx.orgId);
    expect(ev.userId).toBe(ctx.user.id);
    expect(ev.source).toBe("proxy");
    expect(ev.contextType).toBe("run");
    expect(ev.contextId).toBe(run.id);
    expect(ev.credentialSource).toBe("system");
    expect(ev.model).toBe("appstrate-medium");
    expect(ev.costUsd).toBeCloseTo(0.01, 10);

    // Hard guarantee: the backing binding never rides the module event.
    expect(Object.keys(ev)).not.toContain("realModel");
    expect(Object.keys(ev)).not.toContain("api");
    expect(JSON.stringify(ev)).not.toContain("deepseek-chat-SECRET");
    expect(JSON.stringify(ev)).not.toContain("openai-completions");
  });

  it("derives chat context for a chat-attributed row and null for an unattributed one", async () => {
    await db.insert(chatSessions).values({
      id: "chs_event_1",
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      chatSessionId: "chs_event_1",
      credentialSource: "org",
      inputTokens: 5,
      outputTokens: 5,
      costUsd: 0.001,
      requestId: "req_event_chat",
    });
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      credentialSource: null,
      inputTokens: 5,
      outputTokens: 5,
      costUsd: 0.001,
      requestId: "req_event_bare",
    });
    await flush();

    expect(events).toHaveLength(2);
    const chatEv = events.find((e) => e.contextType === "chat")!;
    expect(chatEv.contextId).toBe("chs_event_1");
    const bareEv = events.find((e) => e.contextType === null)!;
    expect(bareEv.contextId).toBeNull();
    expect(bareEv.credentialSource).toBeNull();
  });

  it("does NOT emit when a runner-monotonic upsert loses the conflict (no row written)", async () => {
    const run = await seedRun({
      packageId: "@ledgerevent/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    const base = {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system" as const,
    };

    // First write inserts → one event.
    await recordLlmUsage(
      { ...base, inputTokens: 200, outputTokens: 100, costUsd: 0.5 },
      { onConflict: "runner-monotonic" },
    );
    await flush();
    expect(events).toHaveLength(1);

    // A regressing write is a no-op (returns null) → the broadcast must NOT fire
    // a second time (a cursor consumer would otherwise see a phantom event).
    const lost = await recordLlmUsage(
      { ...base, inputTokens: 1, outputTokens: 1, costUsd: 0.3 },
      { onConflict: "runner-monotonic" },
    );
    await flush();
    expect(lost).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("zero-cost runner row: an equal cost with a higher token total updates the row AND re-emits", async () => {
    const run = await seedRun({
      packageId: "@ledgerevent/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    const base = {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system" as const,
    };

    // A free / zero-rate model pins cost at 0 on every cumulative metric event.
    const id1 = await recordLlmUsage(
      {
        ...base,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0,
      },
      { onConflict: "runner-monotonic" },
    );
    await flush();
    expect(typeof id1).toBe("number");
    expect(events).toHaveLength(1);

    // Same cost (still 0) but the cumulative token snapshot grew — the token
    // tiebreak must advance the row (a cost-only rule would freeze the columns)
    // and re-emit, consistent with a real change.
    const id2 = await recordLlmUsage(
      {
        ...base,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0,
      },
      { onConflict: "runner-monotonic" },
    );
    await flush();
    expect(id2).toBe(id1);
    expect(events).toHaveLength(2);

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);
    expect(row!.cacheReadTokens).toBe(20);
    expect(row!.cacheWriteTokens).toBe(10);
  });

  it("an exact duplicate (same cost AND same tokens) is a no-op that neither updates nor re-emits", async () => {
    const run = await seedRun({
      packageId: "@ledgerevent/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    const entry = {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system" as const,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.5,
    };

    const id1 = await recordLlmUsage(entry, { onConflict: "runner-monotonic" });
    await flush();
    expect(typeof id1).toBe("number");
    expect(events).toHaveLength(1);

    // Replaying the identical cumulative snapshot must change nothing and fire
    // nothing — the idempotence cursor consumers rely on (strict inequalities on
    // both cost and the token tiebreak).
    const dup = await recordLlmUsage(entry, { onConflict: "runner-monotonic" });
    await flush();
    expect(dup).toBeNull();
    expect(events).toHaveLength(1);

    const row = await rowById(id1!);
    expect(row!.costUsd).toBeCloseTo(0.5, 10);
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(100);
  });
});
