// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side read-state for chat sessions.
 *
 * `unread` is computed server-side from two watermarks on `chat_sessions`:
 * `lastAssistantAt` (advanced only when an assistant message persists) and
 * `lastReadAt` (advanced by `PUT /sessions/:id/read` and by persisting a user
 * message — sending implies having seen the thread). Only the boolean crosses
 * the wire, so read-state is shared across devices and immune to client clocks.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { persistUserMessage, persistAssistantMessage } from "../src/persistence.ts";
import type { UIMessage } from "ai";

const app = getTestApp();

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

/** Watermarks are timestamps — keep consecutive persists strictly ordered. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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
    await tick();
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");

    expect((await getSession(id)).unread).toBe(true);

    const list = await app.request("/api/chat/sessions", { headers: authHeaders(ctx) });
    const body = (await list.json()) as { data: { id: string; unread: boolean }[] };
    expect(body.data.find((s) => s.id === id)?.unread).toBe(true);
  });

  it("PUT /read clears unread and is idempotent", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await tick();
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect((await getSession(id)).unread).toBe(true);

    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);

    // Idempotent — repeating is a 204 no-op.
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);
  });

  it("sending a user message marks the thread seen; renaming does not unread it", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await tick();
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    await tick();

    // Sending a follow-up implies the sender saw the reply.
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
    await tick();
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).unread).toBe(false);
    await tick();

    await persistAssistantMessage(id, uiMessage("a2", "assistant", "one more thing"), "a1");
    expect((await getSession(id)).unread).toBe(true);
  });

  it("PUT /read does not bump updatedAt (opening never reorders the sidebar)", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hello"));
    await tick();
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "hi"), "u1");

    const before = (await getSession(id)).updatedAt;
    await tick();
    expect(await markRead(id)).toBe(204);
    expect((await getSession(id)).updatedAt).toBe(before);
  });

  it("cross-user and cross-org mark-read are 404", async () => {
    const id = await createSession();
    const other = await createTestContext({ orgSlug: "otherorg" });
    expect(await markRead(id, authHeaders(other))).toBe(404);
  });
});
