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
 *
 * A guard that cannot be raced is only half of the invariant, though: it still
 * answers whatever the session row says, and the TURN is what has to make that
 * row say the truth. `claimTurn` is the other half — it marks the session as
 * claimed BEFORE it writes the user message, so the window in which
 * `active_stream_id IS NULL` is true of a turn already under way does not
 * exist. Asserting that needs no second connection, only a look at the row as
 * the message lands; see `installClaimProbe`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { UIMessage } from "ai";
import { asc, eq, sql } from "drizzle-orm";
import { db, listenClient, toRows } from "@appstrate/db/client";
import { chatMessages, chatSessions, files } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../../apps/api/test/helpers/seed.ts";
import { describeRequiresPostgres } from "../../../apps/api/test/helpers/tier.ts";
import { persistNotice, persistUserMessage } from "../src/persistence.ts";
import { claimTurn } from "../src/chat-stream.ts";
import { reconcileChatRun, runNoticeMessageId } from "../src/run-reconcile.ts";
import { setActiveStream } from "../src/resumable.ts";

let ctx: TestContext;
let packageId: string;

async function createSession(): Promise<string> {
  const id = `chs_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(chatSessions).values({
    id,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
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

/**
 * Record, for every row that lands in `chat_messages`, exactly what
 * `persistNotice`'s guard would have read at that instant.
 *
 * A BEFORE INSERT trigger is the only vantage point that sees the middle of a
 * turn's claim: the two writes are separate autocommit statements, so from
 * outside the only observable states are "neither happened" and "both did".
 * The recorded value IS the guard's input — `active_stream_id` on the session
 * the message belongs to — so a NULL here is not a proxy for the defect, it is
 * the defect: a notice arriving at that moment would have been let through.
 */
async function installClaimProbe(): Promise<void> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS claim_probe (n serial PRIMARY KEY, active_stream_id text)`,
  );
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION claim_probe_fn() RETURNS trigger AS $$
    BEGIN
      INSERT INTO claim_probe (active_stream_id)
      SELECT active_stream_id FROM chat_sessions WHERE id = NEW.session_id;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.execute(sql`DROP TRIGGER IF EXISTS claim_probe_trg ON chat_messages`);
  await db.execute(sql`
    CREATE TRIGGER claim_probe_trg BEFORE INSERT ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION claim_probe_fn()`);
}

/**
 * Same trigger slot, opposite job: make every `chat_messages` INSERT fail, so
 * the turn's claim is taken and the write it was taken for then dies. Removed
 * by {@link removeClaimProbe} like the recording variant.
 */
async function failEveryMessageInsert(): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION claim_probe_fn() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'claim probe: message insert refused';
    END $$ LANGUAGE plpgsql`);
  await db.execute(sql`DROP TRIGGER IF EXISTS claim_probe_trg ON chat_messages`);
  await db.execute(sql`
    CREATE TRIGGER claim_probe_trg BEFORE INSERT ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION claim_probe_fn()`);
}

/** Everything the two installers created — this DB outlives the test file. */
async function removeClaimProbe(): Promise<void> {
  await db.execute(sql`DROP TRIGGER IF EXISTS claim_probe_trg ON chat_messages`);
  await db.execute(sql`DROP FUNCTION IF EXISTS claim_probe_fn()`);
  await db.execute(sql`DROP TABLE IF EXISTS claim_probe`);
}

/** What the probe saw, oldest first. */
async function probedStreamIds(): Promise<Array<string | null>> {
  const result = await db.execute(sql`SELECT active_stream_id FROM claim_probe ORDER BY n`);
  return toRows<{ active_stream_id: string | null }>(result).map((r) => r.active_stream_id);
}

/**
 * Collect `chat_session_update` payloads for one session.
 *
 * `notifySessionUpdate` is fire-and-forget by construction, so the signal lands
 * a tick or two after the write it announces — poll for it rather than
 * sleeping. `listenClient` has no unlisten, so the handler filters by session
 * id and every session id here is a fresh uuid.
 */
async function watchSessionSignals(sessionId: string): Promise<() => number> {
  let count = 0;
  await listenClient.listen("chat_session_update", (payload) => {
    const parsed = JSON.parse(payload) as { session_id?: string };
    if (parsed.session_id === sessionId) count += 1;
  });
  return () => count;
}

/** Wait until `at least` signals have landed, or fail with what did. */
async function expectSignals(seen: () => number, atLeast: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (seen() < atLeast && Date.now() < deadline) await Bun.sleep(10);
  expect(seen()).toBeGreaterThanOrEqual(atLeast);
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
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

  it("a turn claims the session BEFORE its user message exists", async () => {
    // The window the guard cannot see. `persistNotice` is atomic against a turn
    // that has ALREADY claimed the session; it is powerless against a turn that
    // has written its user message and not claimed yet, because at that instant
    // the column truthfully says NULL. Closing that is the turn's job.
    const sessionId = await createSession();
    await installClaimProbe();
    try {
      await claimTurn(sessionId, "strm_claim", userMessage("u1", "bonjour"));
      // Exactly one message landed, and the session was already claimed when it
      // did. With the write ordered first this reads `[null]`: a notice
      // committing in that gap takes the seq between the user message and the
      // assistant answer, and marks unread a session its owner is watching.
      expect(await probedStreamIds()).toEqual(["strm_claim"]);
    } finally {
      await removeClaimProbe();
    }
  });

  it("releases the claim when the user message cannot be written", async () => {
    // The other side of claiming first: the marker must not outlive a turn that
    // never started, or the session is stuck "generating" for good — the resume
    // GET answering 204 and `persistNotice` refusing forever.
    const sessionId = await createSession();
    await failEveryMessageInsert();
    try {
      await expect(
        claimTurn(sessionId, "strm_failed", userMessage("u1", "bonjour")),
      ).rejects.toThrow();
    } finally {
      await removeClaimProbe();
    }

    const [row] = await db
      .select({ activeStreamId: chatSessions.activeStreamId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    expect(row?.activeStreamId).toBeNull();
    expect(await messageIds(sessionId)).toEqual([]);
  });

  it("still signals the owner after a write commits", async () => {
    // The change signal moved OUT of `touchSession` and onto its callers, so
    // that `persistNotice` can raise it after `db.transaction` returns rather
    // than from inside it (the `pg_notify` rides the pooled `db`, a different
    // connection, and used to autocommit before the notice row did — the SSE
    // fan-out fired and the client refetched a transcript without the notice).
    // The ordering itself needs two real backends to observe; what this pins is
    // that both moved call sites still fire at all.
    const sessionId = await createSession();
    const seen = await watchSessionSignals(sessionId);

    await persistUserMessage(sessionId, userMessage("u1", "bonjour"));
    await expectSignals(seen, 1);

    expect(
      await persistNotice({ sessionId, orgId: ctx.orgId, messageId: "notice_signal", text: "hi" }),
    ).toBe(true);
    await expectSignals(seen, 2);
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
