// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side read-state for chat sessions.
 *
 * `unread` is computed server-side from two MESSAGE-POINTER watermarks on
 * `chat_sessions` (`chat_messages.seq`, the Slack/Discord read-marker model):
 * `lastAssistantSeq` advances only when an assistant message persists;
 * `lastReadSeq` advances monotonically via `PUT /sessions/:id/read` and when a
 * user message persists (sending implies having seen the thread). Only the
 * boolean crosses the wire — no clock is involved anywhere, which is why these
 * tests need no sleeps between persists.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { persistUserMessage, persistAssistantMessage, ensureSession } from "../src/persistence.ts";
import { db } from "@appstrate/db/client";
import { sql } from "drizzle-orm";
import type { UIMessage } from "ai";

const app = getTestApp();

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

describe("chat session read-state", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatorg" });
  });

  async function createSession(): Promise<string> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function getSession(id: string, headers = authHeaders(ctx)) {
    const res = await app.request(`/api/chat/sessions/${id}`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as { unread: boolean; updatedAt: string };
  }

  async function markRead(id: string, headers = authHeaders(ctx)): Promise<number> {
    const res = await app.request(`/api/chat/sessions/${id}/read`, {
      method: "PUT",
      headers,
    });
    return res.status;
  }

  it("a new session is read; an assistant reply makes it unread", async () => {
    const id = await createSession();
    expect((await getSession(id)).unread).toBe(false);

    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");

    expect((await getSession(id)).unread).toBe(true);

    const list = await app.request("/api/chat/sessions", { headers: authHeaders(ctx) });
    const body = (await list.json()) as { data: { id: string; unread: boolean }[] };
    expect(body.data.find((s) => s.id === id)?.unread).toBe(true);
  });

  it("PUT /read clears unread and is idempotent", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect((await getSession(id)).unread).toBe(true);

    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);

    // Idempotent — repeating is a 204 no-op, and the monotonic marker
    // (GREATEST) means a replayed call can never regress the read state.
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);
  });

  it("sending a user message marks the thread seen; renaming does not unread it", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");

    // Sending a follow-up implies the sender saw the reply: the user message's
    // seq is necessarily past the assistant's.
    await persistUserMessage(id, uiMessage("u2", "user", "thanks"));
    expect((await getSession(id)).unread).toBe(false);

    const rename = await app.request(`/api/chat/sessions/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "renamed" }),
    });
    expect(rename.status).toBe(204);
    expect((await getSession(id)).unread).toBe(false);
  });

  it("a reply landing after a read makes the session unread again", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);

    await persistAssistantMessage(id, uiMessage("a2", "assistant", "one more thing"), "a1");
    expect((await getSession(id)).unread).toBe(true);
  });

  it("a retried assistant persist (same message) does not re-unread a read session", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect(await markRead(id)).toBe(204);

    // Idempotent finalize retry: the upsert returns the EXISTING row's seq, so
    // the watermark does not advance past the read marker.
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect((await getSession(id)).unread).toBe(false);
  });

  it("PUT /read does not bump updatedAt (opening never reorders the sidebar)", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");

    const before = (await getSession(id)).updatedAt;
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).updatedAt).toBe(before);
  });

  it("cross-user and cross-org mark-read are 404", async () => {
    const id = await createSession();
    const other = await createTestContext({ orgSlug: "otherorg" });
    expect(await markRead(id, authHeaders(other))).toBe(404);
  });

  /**
   * The title is derived by a query that filters on the role INSIDE the jsonb
   * payload (`content->>'role'`) and bounds the scan. A wrong operator there
   * returns no rows and the title silently stays null forever, so it needs an
   * assertion rather than a green suite that never looked.
   */
  it("derives the title from the first user message, skipping assistant turns", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "Combien de runs ce mois-ci ?"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "Quarante-deux."), "u1");
    await persistUserMessage(id, uiMessage("u2", "user", "Et le mois dernier ?"), "a1");

    const res = await app.request(`/api/chat/sessions/${id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { title: string | null }).toMatchObject({
      title: "Combien de runs ce mois-ci ?",
    });
  });

  it("skips a user message with no text and titles from the next one", async () => {
    const id = await createSession();
    // Only an attachment part: `uiMessageText` yields "" and the loop must go on.
    await persistUserMessage(id, {
      id: "u1",
      role: "user",
      parts: [{ type: "file", url: "appfile://file_1", mediaType: "text/plain" }],
    } as unknown as UIMessage);
    await persistUserMessage(id, uiMessage("u2", "user", "Résume ce fichier"), "u1");

    const res = await app.request(`/api/chat/sessions/${id}`, { headers: authHeaders(ctx) });
    expect((await res.json()) as { title: string | null }).toMatchObject({
      title: "Résume ce fichier",
    });
  });
});

describe("ensureSession refuses a foreign session without writing to it", () => {
  let owner: TestContext;
  let stranger: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "victimorg" });
    stranger = await createTestContext({ orgSlug: "strangerorg" });
  });

  /**
   * `xmin` is the transaction that produced the row's current version. Postgres
   * bumps it on ANY update, including one that writes a column its own value —
   * which is exactly the write we are asserting does not happen. Nothing
   * user-visible would move today (`chat_sessions.updatedAt` is `.defaultNow()`
   * with no `$onUpdateFn`), so a test written against observable columns would
   * pass either way and go on passing right up until someone adds one.
   */
  async function xminOf(id: string): Promise<string> {
    // `db.execute` returns a bare row array on postgres.js and a `{ rows }`
    // envelope on PGlite; the suite runs on both depending on TEST_TIER.
    const res = await db.execute(sql`select xmin::text as x from chat_sessions where id = ${id}`);
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as {
      x: string;
    }[];
    const row = rows[0];
    if (!row) throw new Error(`session ${id} not found`);
    return row.x;
  }

  async function createSessionAs(ctx: TestContext): Promise<string> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("control: the owner's own ensureSession DOES rewrite the row", async () => {
    // Without this the assertion below would hold just as well against a table
    // whose xmin never moves, and would be proving nothing.
    const id = await createSessionAs(owner);
    const before = await xminOf(id);
    await ensureSession(id, owner.orgId, owner.user.id);
    expect(await xminOf(id)).not.toBe(before);
  });

  it("a stranger naming the id gets 404 and leaves the row byte-identical", async () => {
    const id = await createSessionAs(owner);
    const before = await xminOf(id);

    await expect(ensureSession(id, stranger.orgId, stranger.user.id)).rejects.toThrow(/not found/i);

    expect(await xminOf(id)).toBe(before);
  });
});
