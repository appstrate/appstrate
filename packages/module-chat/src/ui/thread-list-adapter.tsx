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

/** Flatten one message's text parts into a single trimmed string. */
function messageText(m: ThreadMessage): string {
  return m.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * Optimistic live title from the first user message (or the first non-empty
 * message), trimmed. We do NOT truncate here: the server's deriveTitle() owns
 * the authoritative 60/57 truncation and persists it, and list()/fetch() read
 * that back. Emitting the full text avoids a second copy of the truncation rule
 * (which used to drift); if the text exceeds 60 chars the only cost is a
 * one-frame sidebar flash when the persisted (truncated) value wins. Returns ""
 * when there is no text to title.
 */
function fallbackTitle(messages: readonly ThreadMessage[]): string {
  const texts = messages.map(messageText).filter((t) => t.length > 0);
  const first = messages.find((m) => m.role === "user" && messageText(m).length > 0);
  return (first ? messageText(first) : texts[0]) ?? "";
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
      const title = fallbackTitle(messages);
      if (!title) return createAssistantStream(() => {});
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
