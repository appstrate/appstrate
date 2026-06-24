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

/**
 * Local title from the first user message, trimmed. Mirrors the server's
 * deriveTitle() truncation (60/57) so the live-emitted title matches the value
 * the server persists — no re-render when list()/fetch() read it back.
 */
function fallbackTitle(items: { role: string; text: string }[]): string {
  const first = items.find((m) => m.role === "user")?.text ?? items[0]?.text ?? "";
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
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
    // Called once after the first turn. The adapter interface requires this
    // method, so we derive the title from the trimmed first user message
    // (no model call) and emit it on the stream so the runtime applies it live.
    // We do NOT persist it here: the server authoritatively persists the same
    // trim via deriveTitle() on the first message append, and list()/fetch()
    // read that back. A client PATCH would be redundant (and, if the trims ever
    // drift, would cause a visible re-render when the server value wins) — so
    // fallbackTitle mirrors deriveTitle's 60/57 truncation exactly.
    async generateTitle(_remoteId, messages) {
      const items = titleInput(messages);
      if (items.length === 0) return createAssistantStream(() => {});
      const title = fallbackTitle(items);
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
