// SPDX-License-Identifier: Apache-2.0

import { gt } from "drizzle-orm";
import type { Db } from "@appstrate/db/client";
import { chatMessages } from "@appstrate/db/schema";
import { historicalChatMessageSchema } from "@appstrate/core/chat-message";

/** Count rows that a later chat turn cannot replay. Never emit their contents, ids or validation errors. */
export async function countInvalidHistoricalChatMessages(
  database: Pick<Db, "select">,
): Promise<number> {
  const pageSize = 100;
  let after: number | undefined;
  let invalid = 0;
  for (;;) {
    const rows = await database
      .select({ seq: chatMessages.seq, content: chatMessages.content })
      .from(chatMessages)
      .where(after === undefined ? undefined : gt(chatMessages.seq, after))
      .orderBy(chatMessages.seq)
      .limit(pageSize);
    for (const { content } of rows) {
      if (!historicalChatMessageSchema.safeParse(content).success) invalid++;
    }
    if (rows.length < pageSize) return invalid;
    after = rows[rows.length - 1]!.seq;
  }
}
