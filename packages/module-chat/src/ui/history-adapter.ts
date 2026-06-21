// SPDX-License-Identifier: Apache-2.0

/**
 * Native assistant-ui history adapter — assistant-ui calls `load()` (via the
 * thread-list) to restore the conversation TREE on mount, and `append()` per
 * message. `withFormat` receives assistant-ui's own format adapter: we just
 * encode/decode against our REST store, so the persisted payload stays
 * opaque (no bespoke message format). Ported from the appstrate-chat
 * satellite (historyAdapter.ts).
 */

import type {
  ThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageFormatRepository,
  MessageStorageEntry,
} from "@assistant-ui/react";
import { fetchEntries, appendEntry, type GetHeaders } from "./sessions.ts";

export function makeHistoryAdapter(
  getHeaders: GetHeaders,
  sessionId: string,
): ThreadHistoryAdapter {
  return {
    // Base load/append are unused with useChatRuntime — it goes through withFormat.
    async load() {
      return { messages: [] };
    },
    async append() {},

    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
    ) {
      const save = async (item: MessageFormatItem<TMessage>) => {
        await appendEntry(getHeaders, sessionId, {
          id: formatAdapter.getId(item.message),
          parent_id: item.parentId,
          format: formatAdapter.format,
          content: formatAdapter.encode(item),
        });
      };
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          const entries = await fetchEntries(getHeaders, sessionId);
          return {
            messages: entries.map((e) =>
              formatAdapter.decode(e as MessageStorageEntry<TStorageFormat>),
            ),
          };
        },
        append: save,
        update: save,
      };
    },
  };
}
