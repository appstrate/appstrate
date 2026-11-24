// SPDX-License-Identifier: Apache-2.0

import { gt } from "drizzle-orm";
import type { Db } from "@appstrate/db/client";
import { chatMessages } from "@appstrate/db/schema";
import { historicalChatMessageSchema } from "@appstrate/core/chat-message";

export interface InvalidHistoricalChatMessage {
  sessionId: string;
  seq: number;
}

/** Rows that a later chat turn cannot replay. Only identifiers leave: never contents or validation errors. */
export async function findInvalidHistoricalChatMessages(
  database: Pick<Db, "select">,
): Promise<InvalidHistoricalChatMessage[]> {
  const pageSize = 100;
  let after: number | undefined;
  const invalid: InvalidHistoricalChatMessage[] = [];
  for (;;) {
    const rows = await database
      .select({
        seq: chatMessages.seq,
        sessionId: chatMessages.sessionId,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(after === undefined ? undefined : gt(chatMessages.seq, after))
      .orderBy(chatMessages.seq)
      .limit(pageSize);
    for (const { seq, sessionId, content } of rows) {
      if (!historicalChatMessageSchema.safeParse(content).success) invalid.push({ sessionId, seq });
    }
    if (rows.length < pageSize) return invalid;
    after = rows[rows.length - 1]!.seq;
  }
}
