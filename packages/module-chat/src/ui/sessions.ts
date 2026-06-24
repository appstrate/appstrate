// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API — they back the NATIVE
 * assistant-ui adapters (thread-list + history). Ported from the
 * appstrate-chat satellite (sessions.ts); auth = the host shell's scoping
 * headers instead of a connection id.
 */

import type { MessageStorageEntry } from "@assistant-ui/react";

export interface SessionSummary {
  id: string;
  title: string | null;
  /** ISO timestamp of the last activity — surfaced as a relative time in the list. */
  updatedAt: string;
}

/** A persisted tree node (the history adapter's storage shape). */
export type Entry = MessageStorageEntry<Record<string, unknown>>;

export type GetHeaders = (() => Record<string, string>) | undefined;

function headers(getHeaders: GetHeaders, json = false): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}

export async function fetchSessions(getHeaders: GetHeaders): Promise<SessionSummary[]> {
  const res = await fetch("/api/chat/sessions", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  // Throw (don't return []) so the assistant-ui thread-list adapter sees a
  // rejected load instead of a fake-empty list — a failed fetch must not render
  // as the "no conversations yet" empty state. Consistent with the write
  // helpers below, which already throw on !res.ok.
  if (!res.ok) throw new Error(`Failed to load conversations (HTTP ${res.status})`);
  return ((await res.json()) as { data?: SessionSummary[] }).data ?? [];
}

export async function createSession(getHeaders: GetHeaders): Promise<SessionSummary> {
  const res = await fetch("/api/chat/sessions", {
    method: "POST",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: "{}",
  });
  if (!res.ok) throw new Error("Could not create the conversation");
  return (await res.json()) as SessionSummary;
}

export async function renameSession(
  getHeaders: GetHeaders,
  id: string,
  title: string,
): Promise<void> {
  await fetch(`/api/chat/sessions/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(getHeaders: GetHeaders, id: string): Promise<void> {
  await fetch(`/api/chat/sessions/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: headers(getHeaders),
  });
}

/** All tree nodes of a conversation (the history adapter's load). */
export async function fetchEntries(getHeaders: GetHeaders, sessionId: string): Promise<Entry[]> {
  const res = await fetch(`/api/chat/sessions/${sessionId}`, {
    credentials: "include",
    headers: headers(getHeaders),
  });
  // Throw (don't return []) so the history adapter doesn't render a conversation
  // whose messages failed to load as an empty thread. Consistent with appendEntry.
  if (!res.ok) throw new Error(`Failed to load conversation (HTTP ${res.status})`);
  return ((await res.json()) as { messages?: Entry[] }).messages ?? [];
}

export async function appendEntry(
  getHeaders: GetHeaders,
  sessionId: string,
  entry: Entry,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify(entry),
  });
  // Surface persistence failures: the assistant-ui history adapter awaits this
  // and would otherwise treat a dropped message as saved, so it silently
  // vanishes on the next reload. Throw so the caller can show an error.
  if (!res.ok) {
    throw new Error(`Failed to persist chat message (HTTP ${res.status})`);
  }
}
