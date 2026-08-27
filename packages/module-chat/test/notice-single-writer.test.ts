// SPDX-License-Identifier: Apache-2.0

/**
 * Chat persistence has two writers, and a turn owns its conversation for its
 * whole life. The second writer (`persistNotice`, driving the orphaned-run
 * reconciliation) must therefore refuse while `chat_sessions.active_stream_id`
 * is set — and refuse ATOMICALLY.
 *
 * It used to be a read-then-write across two statements: `reconcileChatRun`
 * read the column, decided the session was idle, then called `persistNotice`,
 * which wrote unconditionally. `setActiveStream` starting a turn between those
 * two chained the notice onto the in-flight user message, bumped
 * `lastAssistantSeq` and marked a session unread that its owner was watching.
 *
 * Two tests, because the guard has two halves:
 *   - it exists at all (any tier);
 *   - it is the SAME statement as the write, so nothing fits in the gap. That
 *     one needs two real connections and is gated on external PostgreSQL —
 *     the tier-0 default is PGlite, one in-process backend, where two
 *     transactions cannot be scheduled against each other at all.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions, files } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../../apps/api/test/helpers/seed.ts";
import { describeRequiresPostgres } from "../../../apps/api/test/helpers/tier.ts";
import { persistNotice } from "../src/persistence.ts";
import { reconcileChatRun, runNoticeMessageId } from "../src/run-reconcile.ts";
import { setActiveStream } from "../src/resumable.ts";

let ctx: TestContext;
let packageId: string;

async function createSession(): Promise<string> {
  const id = `chs_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(chatSessions).values({
    id,
    orgId: ctx.orgId,
    userId: ctx.user.id,
    title: null,
    activeStreamId: null,
  });
  return id;
}

async function createRunWithFile(chatSessionId: string): Promise<string> {
  const run = await seedRun({
    packageId,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    status: "success",
    chatSessionId,
  });
  const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(files).values({
    id,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    purpose: "agent_output",
    runId: run.id,
    packageId,
    userId: ctx.user.id,
    storageKey: `files/${ctx.defaultSpaceId}/${id}/report.html`,
    name: "report.html",
    mime: "text/html",
    size: 22_846,
    sha256: "deadbeef",
  });
  return run.id;
}

async function messageIds(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ messageId: chatMessages.messageId })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.seq));
  return rows.map((r) => r.messageId);
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "noticeorg" });
  const pkg = await seedPackage({ orgId: ctx.orgId, id: "@noticeorg/writer" });
  packageId = pkg.id;
});

describe("persistNotice single-writer guard", () => {
  it("writes into an idle session", async () => {
    // Control: the guard must not be a blanket refusal. Passes before and after.
    const sessionId = await createSession();
    const posted = await persistNotice({
      sessionId,
      orgId: ctx.orgId,
      messageId: "notice_idle",
      text: "idle",
    });
    expect(posted).toBe(true);
    expect(await messageIds(sessionId)).toEqual(["notice_idle"]);
  });

  it("refuses while a turn owns the session", async () => {
    const sessionId = await createSession();
    await setActiveStream(sessionId, "strm_live");

    const posted = await persistNotice({
      sessionId,
      orgId: ctx.orgId,
      messageId: "notice_live",
      text: "should never be written",
    });

    expect(posted).toBe(false);
    expect(await messageIds(sessionId)).toEqual([]);
  });

  it("refuses to write into another tenant's session", async () => {
    const sessionId = await createSession();
    const posted = await persistNotice({
      sessionId,
      orgId: crypto.randomUUID(),
      messageId: "notice_foreign",
      text: "should never be written",
    });
    expect(posted).toBe(false);
    expect(await messageIds(sessionId)).toEqual([]);
  });
});

describeRequiresPostgres("persistNotice vs a turn starting in the gap", () => {
  /**
   * The interleaving itself, driven from a second connection.
   *
   * The test transaction takes the session row's lock — standing in for the
   * turn that is about to claim it — and only THEN starts the reconciliation,
   * which runs its whole read phase unobstructed (a plain `SELECT` does not
   * wait on a row lock) and blocks on the write path. The turn then starts
   * inside that window and commits.
   *
   * With the guard in the same statement as the write, Postgres re-checks the
   * predicate against the row the turn just wrote and the notice is refused.
   * With the old read-then-write, the read already happened, the INSERT does
   * not touch `chat_sessions` at all, and the notice lands beside a live turn.
   */
  it("cannot interleave a notice with a turn that starts mid-write", async () => {
    const sessionId = await createSession();
    const runId = await createRunWithFile(sessionId);

    let reconcile: Promise<boolean> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1)
        .for("update");

      reconcile = reconcileChatRun({ runId, orgId: ctx.orgId });
      // Swallow here so a rejection during the window is not an unhandled
      // rejection; the assertion below still sees it.
      void reconcile.catch(() => {});
      // Let the reconciliation reach the write path and block on the lock.
      await Bun.sleep(250);

      // The turn starts IN THE GAP — this is the whole point of the test.
      await tx
        .update(chatSessions)
        .set({ activeStreamId: "strm_live" })
        .where(eq(chatSessions.id, sessionId));
    });

    expect(await reconcile).toBe(false);
    expect(await messageIds(sessionId)).not.toContain(runNoticeMessageId(runId));
    expect(await messageIds(sessionId)).toEqual([]);
  });

  it("posts when no turn claims the session in the window", async () => {
    // Control for the same harness: identical interleaving, minus the turn.
    // Passes before and after.
    const sessionId = await createSession();
    const runId = await createRunWithFile(sessionId);

    let reconcile: Promise<boolean> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1)
        .for("update");
      reconcile = reconcileChatRun({ runId, orgId: ctx.orgId });
      void reconcile.catch(() => {});
      await Bun.sleep(250);
    });

    expect(await reconcile).toBe(true);
    expect(await messageIds(sessionId)).toEqual([runNoticeMessageId(runId)]);
  });
});
