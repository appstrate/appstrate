// SPDX-License-Identifier: Apache-2.0

/**
 * Detach-on-delete for the `llm_usage` billing ledger (migration 0028). A ledger
 * row is billed AFTER the fact by a cursor consumer, so it must survive deletion
 * of its CONTEXT (run / chat session) — losing only the context pointer, never
 * its existence — otherwise a not-yet-swept row is erased and its spend escapes
 * billing. Org deletion keeps full CASCADE (total teardown).
 *
 * Locks down:
 *   - run deletion (service + raw FK) → run_id NULLed, row + org_id +
 *     credential_source preserved, settled frontier covers the detached rows;
 *   - chat-session deletion → chat_session_id NULLed, row preserved;
 *   - org deletion → rows GONE (cascade preserved);
 *   - a detached runner row (run_id NULL) is returned by the cursor read and
 *     counted settled.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import {
  deletePackageRuns,
  listLlmUsage,
  getSettledFrontierId,
} from "../../../src/services/state/runs.ts";
import { llmUsage, runs, chatSessions, organizations } from "@appstrate/db/schema";

describe("llm_usage detach-on-delete (migration 0028)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "detachorg" });
    await seedAgent({ id: "@detachorg/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  /** Seed a terminal run + one settled system runner row + one proxy row. */
  async function seedRunWithLedger(): Promise<{
    runId: string;
    runnerId: number;
    proxyId: number;
  }> {
    const run = await seedRun({
      packageId: "@detachorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      completedAt: new Date(),
    });
    const [runner] = await db
      .insert(llmUsage)
      .values({
        source: "runner",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        runId: run.id,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 200,
        costUsd: 0.01,
      })
      .returning({ id: llmUsage.id });
    const [proxy] = await db
      .insert(llmUsage)
      .values({
        source: "proxy",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        runId: run.id,
        credentialSource: "org",
        requestId: "req_detach_1",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.02,
      })
      .returning({ id: llmUsage.id });
    return { runId: run.id, runnerId: runner!.id, proxyId: proxy!.id };
  }

  it("detaches ledger rows when runs are bulk-deleted via deletePackageRuns", async () => {
    const { runId, runnerId, proxyId } = await seedRunWithLedger();

    const deleted = await deletePackageRuns(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      "@detachorg/agent",
    );
    expect(deleted).toBe(1);

    // Run is gone.
    const [gone] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(gone).toBeUndefined();

    // Both ledger rows survive, detached (run_id NULL), org_id + credential_source intact.
    const rows = await db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.runId).toBeNull();
      expect(r.orgId).toBe(ctx.orgId);
    }
    const runner = rows.find((r) => r.id === runnerId);
    const proxy = rows.find((r) => r.id === proxyId);
    expect(runner!.credentialSource).toBe("system");
    expect(runner!.costUsd).toBe(0.01);
    expect(proxy!.credentialSource).toBe("org");
    expect(proxy!.requestId).toBe("req_detach_1");

    // Both detached rows are settled → the frontier reaches them.
    const frontier = await getSettledFrontierId();
    expect(frontier).toBeGreaterThanOrEqual(Math.max(runnerId, proxyId));
  });

  it("detaches ledger rows on a raw run delete (FK ON DELETE SET NULL)", async () => {
    const { runId, runnerId, proxyId } = await seedRunWithLedger();

    // The raw FK behavior — any run deletion path detaches, not just the route.
    await db.delete(runs).where(eq(runs.id, runId));

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.runId === null)).toBe(true);
    expect(rows.every((r) => r.orgId === ctx.orgId)).toBe(true);

    const frontier = await getSettledFrontierId();
    expect(frontier).toBeGreaterThanOrEqual(Math.max(runnerId, proxyId));
  });

  it("detaches a chat-attributed proxy row when its chat session is deleted", async () => {
    await db.insert(chatSessions).values({
      id: "chs_detach_1",
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    const [row] = await db
      .insert(llmUsage)
      .values({
        source: "proxy",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        chatSessionId: "chs_detach_1",
        credentialSource: "org",
        requestId: "req_detach_chat",
        inputTokens: 5,
        outputTokens: 6,
        costUsd: 0.03,
      })
      .returning({ id: llmUsage.id });

    await db.delete(chatSessions).where(eq(chatSessions.id, "chs_detach_1"));

    const [survivor] = await db.select().from(llmUsage).where(eq(llmUsage.id, row!.id));
    expect(survivor).toBeDefined();
    expect(survivor!.chatSessionId).toBeNull();
    expect(survivor!.orgId).toBe(ctx.orgId);
    expect(survivor!.credentialSource).toBe("org");
    expect(survivor!.costUsd).toBe(0.03);
  });

  it("cascades the whole ledger when the org is deleted (total teardown)", async () => {
    await seedRunWithLedger();
    expect((await db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId))).length).toBe(2);

    await db.delete(organizations).where(eq(organizations.id, ctx.orgId));

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId));
    expect(rows.length).toBe(0);
  });

  it("returns a detached runner row (run_id NULL) as settled from the cursor read", async () => {
    // A runner row with run_id NULL is exactly a post-detach row. The dropped
    // `llm_usage_runner_has_run_id` CHECK previously forbade this insert.
    const [row] = await db
      .insert(llmUsage)
      .values({
        source: "runner",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        runId: null,
        credentialSource: "system",
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0.04,
      })
      .returning({ id: llmUsage.id });

    const listed = await listLlmUsage({});
    const found = listed.find((r) => r.id === row!.id);
    expect(found).toBeDefined();
    expect(found!.contextType).toBeNull();
    expect(found!.contextId).toBeNull();
    expect(found!.settled).toBe(true);

    const frontier = await getSettledFrontierId();
    expect(frontier).toBeGreaterThanOrEqual(row!.id);
  });
});
