// SPDX-License-Identifier: Apache-2.0

/**
 * The title a conversation takes from its first user message: whole when
 * short, cut at a word boundary when long — never in the middle of a word.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { persistUserMessage } from "../src/persistence.ts";

const app = getTestApp();

describe("the title derived from a first message", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chattitleorg" });
  });

  async function titleOf(text: string): Promise<string | null> {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { id } = (await res.json()) as { id: string };
    await persistUserMessage(id, {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text }],
    } as UIMessage);
    const [session] = await db
      .select({ title: chatSessions.title })
      .from(chatSessions)
      .where(eq(chatSessions.id, id));
    return session!.title;
  }

  it("keeps a message of up to 60 characters whole", async () => {
    const text = "x".repeat(60);
    expect(await titleOf(text)).toBe(text);
  });

  it("cuts a long message at a word boundary, not inside a word", async () => {
    // The 57-character head ends inside "autre": it used to read "…d'aut…".
    expect(
      await titleOf(
        "Réponds simplement par le mot OK, sans rien ajouter d'autre que ce mot, et rien de plus.",
      ),
    ).toBe("Réponds simplement par le mot OK, sans rien ajouter…");
  });

  it("keeps the head as is when it already ends on a word", async () => {
    const head = `${"a".repeat(28)} ${"b".repeat(28)}`;
    expect(await titleOf(`${head} ${"c".repeat(20)}`)).toBe(`${head}…`);
  });

  it("cuts inside a long token rather than keep only the short word before it", async () => {
    // The only boundary is after "Regarde": cutting there would leave "Regarde…".
    const text = `Regarde https://example.com/${"a".repeat(80)}`;
    expect(await titleOf(text)).toBe(`${text.slice(0, 57)}…`);
  });

  it("cuts one unbroken word where the head ends", async () => {
    expect(await titleOf("x".repeat(80))).toBe(`${"x".repeat(57)}…`);
  });
});
