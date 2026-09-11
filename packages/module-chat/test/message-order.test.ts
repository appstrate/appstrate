// SPDX-License-Identifier: Apache-2.0

/**
 * `seq` is the only thing that orders a transcript.
 *
 * The table used to carry a `parent_id` chain beside it and the history DTO
 * echoed that chain to the client; migration 0054 dropped both, because every
 * read is `ORDER BY seq` and nothing ever walked the chain. What is pinned here
 * is the property the column looked like it was providing: `GET /sessions/{id}`
 * returns the messages in insertion order, as bare `{ id, content }` nodes.
 *
 * The second test falsifies `created_at` deliberately. Two messages of one turn
 * can share a clock tick, so a transcript sorted by it would be unstable — and
 * a reversed clock is the only way this test fails loudly if someone reaches
 * for one.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { persistUserMessage, persistAssistantMessage, persistNotice } from "../src/persistence.ts";
import type { UIMessage } from "ai";

const app = getTestApp();

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

describe("chat transcript ordering", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatorderorg" });
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

  async function history(id: string): Promise<Record<string, unknown>[]> {
    const res = await app.request(`/api/chat/sessions/${id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { messages: Record<string, unknown>[] }).messages;
  }

  it("returns the transcript in insertion order, as { id, content } nodes", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "bonjour"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "salut"), "u1");
    // A server-authored notice goes through the same writer, so it takes the
    // next seq like anything else.
    expect(
      await persistNotice({
        sessionId: id,
        orgId: ctx.orgId,
        messageId: "notice_1",
        text: "un run a livré report.html",
      }),
    ).toBe(true);
    await persistUserMessage(id, uiMessage("u2", "user", "merci"));
    await persistAssistantMessage(id, uiMessage("a2", "assistant", "de rien"), "u2");

    const messages = await history(id);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "notice_1", "u2", "a2"]);
    // An identity and an opaque payload, nothing else: no ordering field for a
    // client to sort by, and no chain for it to walk.
    for (const message of messages) {
      expect(Object.keys(message).sort()).toEqual(["content", "id"]);
    }
  });

  it("orders by seq, not by the clock", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "un"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "deux"), "u1");
    await persistUserMessage(id, uiMessage("u2", "user", "trois"));

    // Reverse the clock against the insertion order: the newest row now claims
    // the oldest timestamp and every timestamp is distinct, so a sort on
    // `created_at` would hand the transcript back backwards.
    await db.execute(
      sql`UPDATE ${chatMessages} SET created_at = now() - (${chatMessages.seq} * interval '1 second')`,
    );

    expect((await history(id)).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });
});
