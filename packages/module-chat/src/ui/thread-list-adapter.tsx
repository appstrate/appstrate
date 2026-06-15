// SPDX-License-Identifier: Apache-2.0

/**
 * Native assistant-ui thread-list adapter over the chat session API.
 * assistant-ui owns the conversation list (create/select/rename/delete) —
 * we provide thin REST methods. `unstable_Provider` injects the per-thread
 * history adapter so the conversation tree restores on reload. Ported from
 * the appstrate-chat satellite (threadListAdapter.tsx).
 */

import { useMemo, type PropsWithChildren } from "react";
import type { RemoteThreadListAdapter, ThreadMessage } from "@assistant-ui/react";
import { RuntimeAdapterProvider, useThreadListItem } from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import {
  fetchSessions,
  createSession,
  renameSession,
  deleteSession,
  generateSessionTitle,
  type GetHeaders,
} from "./sessions.ts";
import { makeHistoryAdapter } from "./history-adapter.ts";

/** First few messages flattened to role + text (input for title generation). */
function titleInput(messages: readonly ThreadMessage[]): { role: string; text: string }[] {
  return messages
    .map((m) => ({
      role: m.role,
      text: m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim(),
    }))
    .filter((m) => m.text.length > 0)
    .slice(0, 6);
}

/** Local fallback when the LLM title call fails — first user message, trimmed. */
function fallbackTitle(items: { role: string; text: string }[]): string {
  const first = items.find((m) => m.role === "user")?.text ?? items[0]?.text ?? "";
  return first.length > 50 ? `${first.slice(0, 47)}…` : first;
}

export function makeThreadListAdapter(getHeaders: GetHeaders): RemoteThreadListAdapter {
  // Per-thread history adapter, keyed by the thread's remoteId (= session id).
  function HistoryProvider({ children }: PropsWithChildren) {
    const remoteId = useThreadListItem((s) => s.remoteId);
    const history = useMemo(
      () => (remoteId ? makeHistoryAdapter(getHeaders, remoteId) : undefined),
      [remoteId],
    );
    const adapters = useMemo(() => ({ history }), [history]);
    return <RuntimeAdapterProvider adapters={adapters}>{children}</RuntimeAdapterProvider>;
  }

  return {
    async list() {
      const sessions = await fetchSessions(getHeaders);
      return {
        threads: sessions.map((s) => ({
          status: "regular" as const,
          remoteId: s.id,
          title: s.title ?? undefined,
          // `custom` is assistant-ui's native per-thread metadata channel; we
          // carry the last-activity timestamp so the list can show a relative time.
          custom: { updatedAt: s.updatedAt },
        })),
      };
    },
    async initialize() {
      const s = await createSession(getHeaders);
      return { remoteId: s.id, externalId: undefined };
    },
    async rename(remoteId, title) {
      await renameSession(getHeaders, remoteId, title);
    },
    async archive() {},
    async unarchive() {},
    async delete(remoteId) {
      await deleteSession(getHeaders, remoteId);
    },
    // Called once after the first turn: ask the LLM for a short title, persist
    // it (rename), and emit it on the stream so the runtime applies it live.
    // Falls back to the trimmed first message if the model call fails.
    async generateTitle(remoteId, messages) {
      const items = titleInput(messages);
      if (items.length === 0) return createAssistantStream(() => {});
      let title = "";
      try {
        title = await generateSessionTitle(getHeaders, items);
      } catch {
        title = "";
      }
      if (!title) title = fallbackTitle(items);
      if (title) void renameSession(getHeaders, remoteId, title).catch(() => {});
      return createAssistantStream((controller) => {
        if (title) controller.appendText(title);
      });
    },
    async fetch(remoteId) {
      const s = (await fetchSessions(getHeaders)).find((x) => x.id === remoteId);
      return {
        status: "regular",
        remoteId,
        title: s?.title ?? undefined,
        custom: s ? { updatedAt: s.updatedAt } : undefined,
      };
    },
    unstable_Provider: HistoryProvider,
  };
}
