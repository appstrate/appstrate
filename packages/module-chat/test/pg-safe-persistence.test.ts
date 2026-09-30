// SPDX-License-Identifier: Apache-2.0

/**
 * A NUL in a chat message — tool/MCP output, a model delta — used to make
 * Postgres refuse the `chat_messages.content` jsonb upsert and the message was
 * dropped (#1501). The single writer now stores it sanitised, and the session
 * title derived from a user turn is stored sanitised too.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
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

describe("chat persistence of Postgres-refused characters", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatpgsafeorg" });
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

  it("persists user and assistant messages carrying a NUL, sanitised", async () => {
    const id = await createSession();
    await persistUserMessage(id, uiMessage("u1", "user", "hi\u0000there"));
    await persistAssistantMessage(id, uiMessage("a1", "assistant", "tool\u0000out\uD800"), "u1");

    const rows = await db
      .select({ messageId: chatMessages.messageId, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(chatMessages.seq);
    expect(rows).toEqual([
      {
        messageId: "u1",
        content: { role: "user", parts: [{ type: "text", text: "hi�there" }] },
      },
      {
        messageId: "a1",
        content: { role: "assistant", parts: [{ type: "text", text: "tool�out�" }] },
      },
    ]);

    const [session] = await db
      .select({ title: chatSessions.title })
      .from(chatSessions)
      .where(eq(chatSessions.id, id));
    expect(session!.title).toBe("hi�there");
  });
});
