// SPDX-License-Identifier: Apache-2.0

/**
 * C3/D5 — a run that outlives the chat turn that launched it reports back.
 *
 * The audited session's `report.html` (22 846 bytes) was produced two minutes
 * AFTER the turn was killed by its deadline, and nothing in the conversation
 * ever mentioned it. Documents are an exclusive container pair (run XOR chat
 * session), so the reconciliation is a MESSAGE — posted through the same
 * single-writer persistence path as every other chat message.
 *
 * What is asserted here:
 *   - the launching session is recorded on `runs.metadata.chatSessionId` without
 *     clobbering whatever else the platform put in that JSONB column;
 *   - the notice is posted exactly ONCE, even on a replayed terminal event;
 *   - nothing is posted while a turn is live on that session (that turn is the
 *     writer, and it is the one reporting the result);
 *   - nothing is posted for a run that produced no document, nor for a run that
 *     was never launched from a chat session.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions, documents, runs } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../../apps/api/test/helpers/seed.ts";
import {
  reconcileChatRun,
  runNoticeMessageId,
  runNoticeText,
  stampChatSessionOnRun,
} from "../src/run-reconcile.ts";
import { runAndWaitStepsWithinTurnBudget } from "../src/run-budget.ts";
import { CHAT_TURN_DEADLINE_MS } from "@appstrate/core/chat-turn-metadata";
import type { RunAndWaitStep } from "@appstrate/core/run-and-wait-client";

describe("orphaned chat run reconciliation", () => {
  let ctx: TestContext;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reconcileorg" });
    const pkg = await seedPackage({ orgId: ctx.orgId, id: "@reconcileorg/writer" });
    packageId = pkg.id;
  });

  async function createSession(overrides: { activeStreamId?: string | null } = {}) {
    const id = `chs_${crypto.randomUUID().replace(/-/g, "")}`;
    await db.insert(chatSessions).values({
      id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      activeStreamId: overrides.activeStreamId ?? null,
    });
    return id;
  }

  async function createRun(metadata: Record<string, unknown> | null) {
    const run = await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "success",
      ...(metadata ? { metadata } : {}),
    });
    return run.id;
  }

  async function publishDocument(runId: string, name: string, size = 22_846) {
    const id = `doc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(documents).values({
      id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      purpose: "agent_output",
      runId,
      packageId,
      userId: ctx.user.id,
      storageKey: `documents/${ctx.defaultAppId}/${id}/${name}`,
      name,
      mime: "text/html",
      size,
      sha256: "deadbeef",
    });
    return id;
  }

  async function messages(sessionId: string) {
    return db
      .select({ messageId: chatMessages.messageId, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq));
  }

  it("records the launching session on runs.metadata without clobbering it", async () => {
    const sessionId = await createSession();
    const runId = await createRun({ degraded_integrations: ["@acme/gmail"] });

    await stampChatSessionOnRun(runId, ctx.orgId, sessionId);

    const [row] = await db
      .select({ metadata: runs.metadata })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(row?.metadata).toEqual({
      degraded_integrations: ["@acme/gmail"],
      chatSessionId: sessionId,
    });
  });

  it("posts the notice once, naming the run and its documents", async () => {
    const sessionId = await createSession();
    const runId = await createRun({ chatSessionId: sessionId });
    await publishDocument(runId, "report.html");

    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(true);

    const rows = await messages(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageId).toBe(runNoticeMessageId(runId));
    const content = rows[0]!.content as { role: string; parts: Array<{ text?: string }> };
    expect(content.role).toBe("assistant");
    expect(content.parts[0]?.text).toContain(runId);
    expect(content.parts[0]?.text).toContain("report.html");

    // The session is now flagged unread, so the sidebar surfaces the delivery.
    const [session] = await db
      .select({
        lastAssistantSeq: chatSessions.lastAssistantSeq,
        lastReadSeq: chatSessions.lastReadSeq,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    expect(session!.lastAssistantSeq).not.toBeNull();
    expect(session!.lastReadSeq).toBeNull();
  });

  it("does not double-post on a replayed terminal event", async () => {
    const sessionId = await createSession();
    const runId = await createRun({ chatSessionId: sessionId });
    await publishDocument(runId, "report.html");

    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(true);
    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(false);
    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(false);

    const rows = await messages(sessionId);
    expect(rows).toHaveLength(1);
    // The replay must not have re-parented the notice onto itself either.
    const [row] = await db
      .select({ parentId: chatMessages.parentId })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.messageId, runNoticeMessageId(runId)),
        ),
      )
      .limit(1);
    expect(row!.parentId).toBeNull();
  });

  it("stays silent while a turn is live on the session", async () => {
    const sessionId = await createSession({ activeStreamId: "stream_live" });
    const runId = await createRun({ chatSessionId: sessionId });
    await publishDocument(runId, "report.html");

    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(false);
    expect(await messages(sessionId)).toHaveLength(0);
  });

  it("stays silent when the run produced nothing", async () => {
    const sessionId = await createSession();
    const runId = await createRun({ chatSessionId: sessionId });

    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(false);
    expect(await messages(sessionId)).toHaveLength(0);
  });

  it("ignores a run that was never launched from a chat session", async () => {
    const sessionId = await createSession();
    const runId = await createRun(null);
    await publishDocument(runId, "report.html");

    await expect(reconcileChatRun({ runId, orgId: ctx.orgId })).resolves.toBe(false);
    expect(await messages(sessionId)).toHaveLength(0);
  });

  it("ignores a run whose org does not match (cross-tenant id)", async () => {
    const sessionId = await createSession();
    const runId = await createRun({ chatSessionId: sessionId });
    await publishDocument(runId, "report.html");

    await expect(
      reconcileChatRun({ runId, orgId: "00000000-0000-0000-0000-000000000000" }),
    ).resolves.toBe(false);
    expect(await messages(sessionId)).toHaveLength(0);
  });
});

describe("run notice text", () => {
  it("links the run page when the run has a package, and lists each document URI", () => {
    const text = runNoticeText({
      runId: "run_abc",
      packageId: "@acme/writer",
      status: "success",
      documents: [{ id: "doc_report001", name: "report.html", size: 22_846 }],
    });
    expect(text).toContain("(/agents/@acme/writer/runs/run_abc)");
    expect(text).toContain("document://doc_report001");
    expect(text).toContain("22846");
  });

  it("omits the link for a run with no package id", () => {
    const text = runNoticeText({
      runId: "run_abc",
      packageId: null,
      status: "failed",
      documents: [{ id: "doc_report001", name: "report.html", size: 1 }],
    });
    expect(text).not.toContain("/agents/");
    expect(text).toContain("`run_abc`");
  });
});

describe("run_and_wait links the launched run to its session", () => {
  const NOW = 1_800_000_000_000;
  const clientOpts = {
    origin: "https://test.local",
    headers: {},
    fetch: (async () => {
      throw new Error("must not reach the platform");
    }) as unknown as typeof fetch,
  };

  async function* twoSteps(): AsyncGenerator<RunAndWaitStep> {
    yield { payload: { id: "run_linked", status: "pending", done: false } };
    yield { payload: { id: "run_linked", status: "success", done: true } };
  }

  it("stamps once, off the preliminary step (before the run can finish)", async () => {
    const links: Array<[string, string, string]> = [];
    const steps: RunAndWaitStep[] = [];
    for await (const step of runAndWaitStepsWithinTurnBudget(
      { kind: "inline", manifest: {}, prompt: "go" },
      {
        ...clientOpts,
        budget: {
          turnDeadlineAt: NOW + CHAT_TURN_DEADLINE_MS,
          engine: "ai-sdk",
          chatSessionId: "chs_1",
          orgId: "org_1",
          now: () => NOW,
        },
      },
      twoSteps as never,
      async (runId, orgId, chatSessionId) => {
        links.push([runId, orgId, chatSessionId]);
      },
    )) {
      steps.push(step);
      // Recorded on the FIRST step, not only at the end.
      if (steps.length === 1) expect(links).toEqual([["run_linked", "org_1", "chs_1"]]);
    }
    expect(links).toEqual([["run_linked", "org_1", "chs_1"]]);
  });

  it("stamps nothing for an ephemeral turn (no session to report into)", async () => {
    const links: string[] = [];
    for await (const _step of runAndWaitStepsWithinTurnBudget(
      { kind: "inline", manifest: {}, prompt: "go" },
      {
        ...clientOpts,
        budget: {
          turnDeadlineAt: NOW + CHAT_TURN_DEADLINE_MS,
          engine: "ai-sdk",
          chatSessionId: null,
          orgId: "org_1",
          now: () => NOW,
        },
      },
      twoSteps as never,
      async (runId) => {
        links.push(runId);
      },
    )) {
      void _step;
    }
    expect(links).toEqual([]);
  });

  it("stamps nothing when the budget refused the launch (no run exists)", async () => {
    const links: string[] = [];
    for await (const _step of runAndWaitStepsWithinTurnBudget(
      { kind: "inline", manifest: {}, prompt: "go" },
      {
        ...clientOpts,
        budget: {
          turnDeadlineAt: NOW + 1_000,
          engine: "ai-sdk",
          chatSessionId: "chs_1",
          orgId: "org_1",
          now: () => NOW,
        },
      },
      twoSteps as never,
      async (runId) => {
        links.push(runId);
      },
    )) {
      void _step;
    }
    expect(links).toEqual([]);
  });
});
