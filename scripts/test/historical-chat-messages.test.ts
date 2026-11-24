// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { createTestContext } from "../../apps/api/test/helpers/auth.ts";
import { findInvalidHistoricalChatMessages } from "../migration/lib/historical-chat-messages.ts";

it("identifies only unreadable historical rows, including rows on the next page", async () => {
  const ctx = await createTestContext({ orgSlug: "history-check" });
  await db.transaction(async (tx) => {
    const before = (await findInvalidHistoricalChatMessages(tx)).length;
    const sessionId = `chs_${crypto.randomUUID()}`;
    await tx.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const old = {
      role: "assistant",
      parts: [{ type: "data-module-extension", data: { active: true } }],
    };
    const rows = [
      { role: "user", parts: [{ type: "text" }] },
      ...Array.from({ length: 100 }, () => old),
      { role: "user", parts: [{ type: "file", url: "appfile://file_12" }] },
    ];
    await tx.execute(sql`
      INSERT INTO chat_messages (session_id, message_id, content)
      SELECT ${sessionId}, 'historical-' || n, content
      FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS entries(content, n)
      ORDER BY n
    `);
    const invalid = await findInvalidHistoricalChatMessages(tx);
    expect(invalid).toHaveLength(before + 2);
    expect(invalid.filter((row) => row.sessionId === sessionId)).toHaveLength(2);
  });
});
