// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for ADR-011 unified persistence service.
 *
 * Coverage:
 *   - Double-write on `finalizeRun`: legacy `runs.state` + `package_memories`
 *     AND new `package_persistence` end up populated for the same finalize.
 *   - Per-scope limit enforcement (100 memories per scope, content cap 2000).
 *   - Dual-event acceptance (`state.set` legacy alias + `checkpoint.set`
 *     canonical) — both fold to the same checkpoint outcome.
 *
 * Migration data-preservation lives in
 * `migration-checkpoint-back-fill.test.ts` (separate file because it
 * exercises raw SQL on a freshly-created table copy).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { encrypt } from "@appstrate/connect";
import { runs, packageMemories, packagePersistence } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent } from "../../helpers/seed.ts";
import { finalizeRun } from "../../../src/services/run-event-ingestion.ts";
import {
  addMemories,
  MAX_MEMORIES_PER_SCOPE,
} from "../../../src/services/state/package-persistence.ts";
import { MAX_MEMORY_CONTENT } from "../../../src/services/state/package-memories.ts";
import type { RunSinkContext } from "../../../src/types/run-sink.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedRunningRun(input: {
  ctx: TestContext;
  packageId: string;
  /**
   * Explicit `null` keeps the dashboard slot unset (scheduled / system run).
   * Omit the key entirely to default to the test context's user.
   */
  dashboardUserId?: string | null;
  endUserId?: string | null;
}): Promise<RunSinkContext> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // Use `in` to differentiate "key absent" (default to ctx user) from
  // "explicit null" (scheduled run, no dashboard user).
  const dashboardUserId =
    "dashboardUserId" in input ? (input.dashboardUserId ?? null) : input.ctx.user.id;
  await db.insert(runs).values({
    id: runId,
    packageId: input.packageId,
    orgId: input.ctx.orgId,
    applicationId: input.ctx.defaultAppId,
    dashboardUserId,
    endUserId: input.endUserId ?? null,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt("sink-secret"),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
  });
  return {
    id: runId,
    orgId: input.ctx.orgId,
    applicationId: input.ctx.defaultAppId,
    packageId: input.packageId,
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt("sink-secret"),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: null,
    lastEventSequence: 0,
    startedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Double-write
// ---------------------------------------------------------------------------

describe("finalizeRun — double-write to legacy + unified persistence", () => {
  let ctx: TestContext;
  const packageId = "@dwriteorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "dwriteorg" });
    await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("memory writes land in both package_memories AND package_persistence", async () => {
    const sink = await seedRunningRun({ ctx, packageId });

    await finalizeRun({
      run: sink,
      result: {
        memories: [{ content: "remember: prefers CSV" }],
        state: null,
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    // Legacy table — app-wide row, no actor dimension.
    const legacy = await db
      .select()
      .from(packageMemories)
      .where(
        and(
          eq(packageMemories.packageId, packageId),
          eq(packageMemories.applicationId, ctx.defaultAppId),
        ),
      );
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.content).toBe("remember: prefers CSV");

    // Unified table — same content, but per-actor (the run's dashboard user
    // is the default scope for unified writes).
    const unified = await db
      .select()
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.applicationId, ctx.defaultAppId),
          eq(packagePersistence.kind, "memory"),
        ),
      );
    expect(unified).toHaveLength(1);
    // Pre-1.4 events have no `scope` field — defaults to the actor scope.
    // The seeded run has dashboardUserId set, so actor_type='user'.
    expect(unified[0]!.actorType).toBe("user");
    expect(unified[0]!.actorId).toBe(ctx.user.id);
    expect(unified[0]!.content).toBe("remember: prefers CSV");
  });

  it("checkpoint writes land in both runs.state AND package_persistence", async () => {
    const sink = await seedRunningRun({ ctx, packageId });

    await finalizeRun({
      run: sink,
      result: {
        memories: [],
        state: { cursor: "abc-123", lastSeen: 42 },
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    // Legacy: stored on the run row itself.
    const [legacy] = await db.select().from(runs).where(eq(runs.id, sink.id)).limit(1);
    expect(legacy!.state).toEqual({ cursor: "abc-123", lastSeen: 42 });

    // Unified: stored as a checkpoint row scoped to the run's actor.
    const unified = await db
      .select()
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.applicationId, ctx.defaultAppId),
          eq(packagePersistence.kind, "checkpoint"),
        ),
      );
    expect(unified).toHaveLength(1);
    expect(unified[0]!.actorType).toBe("user");
    expect(unified[0]!.actorId).toBe(ctx.user.id);
    expect(unified[0]!.content).toEqual({ cursor: "abc-123", lastSeen: 42 });
  });

  it("scheduled / system runs (no actor) write checkpoint as actor_type='shared'", async () => {
    // dashboardUserId=null + endUserId=null → run's actor is `shared`.
    const sink = await seedRunningRun({ ctx, packageId, dashboardUserId: null });

    await finalizeRun({
      run: sink,
      result: {
        memories: [],
        state: { universal: true },
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    const unified = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    expect(unified).toHaveLength(1);
    expect(unified[0]!.actorType).toBe("shared");
    expect(unified[0]!.actorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Limit enforcement
// ---------------------------------------------------------------------------

describe("addMemories — limit enforcement", () => {
  let ctx: TestContext;
  const packageId = "@limitorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "limitorg" });
    await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("the 101st memory in a scope is silently dropped (matches legacy behaviour)", async () => {
    const scope = { type: "shared" as const };
    const batch1 = Array.from({ length: MAX_MEMORIES_PER_SCOPE }, (_, i) => `memo-${i}`);

    const inserted1 = await addMemories(
      packageId,
      ctx.defaultAppId,
      ctx.orgId,
      scope,
      batch1,
      null,
    );
    expect(inserted1).toBe(MAX_MEMORIES_PER_SCOPE);

    // 101st write — must be rejected (return 0 inserted).
    const inserted2 = await addMemories(
      packageId,
      ctx.defaultAppId,
      ctx.orgId,
      scope,
      ["overflow"],
      null,
    );
    expect(inserted2).toBe(0);

    const [{ value }] = await db
      .select({ value: count() })
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.kind, "memory"),
          eq(packagePersistence.actorType, "shared"),
        ),
      );
    expect(value).toBe(MAX_MEMORIES_PER_SCOPE);
  });

  it("memory content > MAX_MEMORY_CONTENT is truncated, not rejected", async () => {
    const overflow = "x".repeat(MAX_MEMORY_CONTENT + 500);
    const inserted = await addMemories(
      packageId,
      ctx.defaultAppId,
      ctx.orgId,
      { type: "shared" },
      [overflow],
      null,
    );
    expect(inserted).toBe(1);

    const [row] = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "memory")),
      )
      .limit(1);
    // Stored as a JSONB string per the service contract.
    expect(typeof row!.content).toBe("string");
    expect((row!.content as string).length).toBe(MAX_MEMORY_CONTENT);
  });

  it("the 100-per-scope limit is enforced PER SCOPE (shared + per-user coexist)", async () => {
    // Fill the shared bucket to its cap.
    const sharedBatch = Array.from({ length: MAX_MEMORIES_PER_SCOPE }, (_, i) => `s-${i}`);
    await addMemories(
      packageId,
      ctx.defaultAppId,
      ctx.orgId,
      { type: "shared" },
      sharedBatch,
      null,
    );

    // The user bucket is empty — a user-scoped insert must still succeed.
    const userInserted = await addMemories(
      packageId,
      ctx.defaultAppId,
      ctx.orgId,
      { type: "member", id: ctx.user.id },
      ["user-only-memo"],
      null,
    );
    expect(userInserted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dual-event acceptance — `state.set` (legacy) vs `checkpoint.set` (canonical)
// ---------------------------------------------------------------------------

describe("finalizeRun — dual-event acceptance for checkpoint", () => {
  let ctx: TestContext;
  const packageId = "@dualorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "dualorg" });
    await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("a finalize with reduced state (no checkpointScope) writes actor-scoped checkpoint", async () => {
    // The reducer path for `state.set` events: aggregates into `result.state`
    // without setting `checkpointScope`. Mirrors what HttpSink emits when a
    // pre-1.4 runner sends a legacy `state.set` event.
    const sink = await seedRunningRun({ ctx, packageId });

    await finalizeRun({
      run: sink,
      result: {
        memories: [],
        state: { from: "state.set" },
        // checkpointScope intentionally omitted — pre-1.4 runners don't set it
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    const rows = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    expect(rows).toHaveLength(1);
    // No explicit scope → falls back to the run's actor scope.
    expect(rows[0]!.actorType).toBe("user");
    expect(rows[0]!.actorId).toBe(ctx.user.id);
    expect(rows[0]!.content).toEqual({ from: "state.set" });
  });

  it("a finalize with checkpointScope='shared' writes a shared checkpoint", async () => {
    // The canonical `checkpoint.set` path: the AFPS 1.4 reducer stamps
    // `checkpointScope` from the event. `"shared"` opts the run's checkpoint
    // out of per-actor isolation.
    const sink = await seedRunningRun({ ctx, packageId });

    await finalizeRun({
      run: sink,
      result: {
        memories: [],
        state: { from: "checkpoint.set" },
        checkpointScope: "shared",
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    const rows = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe("shared");
    expect(rows[0]!.actorId).toBeNull();
    expect(rows[0]!.content).toEqual({ from: "checkpoint.set" });
  });

  it("checkpointScope='actor' lands on the run's actor scope (matches default)", async () => {
    const sink = await seedRunningRun({ ctx, packageId });

    await finalizeRun({
      run: sink,
      result: {
        memories: [],
        state: { from: "checkpoint.set" },
        checkpointScope: "actor",
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink.id}`,
    });

    const rows = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe("user");
    expect(rows[0]!.actorId).toBe(ctx.user.id);
  });

  it("upsert behaviour: a second checkpoint for the same actor overwrites the first", async () => {
    const sink1 = await seedRunningRun({ ctx, packageId });
    await finalizeRun({
      run: sink1,
      result: {
        memories: [],
        state: { v: 1 },
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink1.id}`,
    });

    const sink2 = await seedRunningRun({ ctx, packageId });
    await finalizeRun({
      run: sink2,
      result: {
        memories: [],
        state: { v: 2 },
        output: null,
        report: null,
        logs: [],
        status: "success",
        usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
      },
      webhookId: `webhook-${sink2.id}`,
    });

    const rows = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    // Single row — the second call must hit the partial unique index and
    // upsert in place, not append. The COALESCE-based ON CONFLICT key is
    // what makes this work for both `shared` and `user` scopes.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toEqual({ v: 2 });
    expect(rows[0]!.runId).toBe(sink2.id);
  });
});
