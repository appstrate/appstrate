// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API. Auth = the host shell's scoping
 * headers (org/space). The server is the single writer of messages, so there is
 * no client message-write helper — only session list/CRUD + history load.
 */

import type { UIMessage } from "ai";
import { DEFAULT_SKILL_SELECTION, type ChatSkillSelection, type SkillHint } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";

/** Fresh session id, minted client-side (`chs_` shape) — re-exported from the shared module. */
export { mintSessionId } from "../session-id.ts";

export interface SessionSummary {
  id: string;
  title: string | null;
  /** True while a turn is generating — drives the poll cadence + unread badge. */
  generating: boolean;
  /** Server-computed: an assistant reply landed after the caller last read it. */
  unread: boolean;
  /** ISO timestamp of the last activity — surfaced as a relative time in the list. */
  updatedAt: string;
}

/**
 * Prefix every chat-session-list key starts with (module-local, not the typed
 * client). Exported for the app shell, which invalidates on it — a prefix match,
 * so it still reaches the space-scoped keys below.
 */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

/**
 * The session list of ONE space. Sessions are space-scoped rows
 * (`chat_sessions.space_id`) and `GET /api/chat/sessions` REQUIRES `X-Space-Id`,
 * so the space belongs in the key twice over: a key without it would serve
 * another space's list from cache, and would stay disabled forever instead of
 * refetching when the space store resolves.
 */
export function sessionsQueryKey(spaceId: string | null): readonly unknown[] {
  return [...SESSIONS_QUERY_KEY, spaceId];
}

/** One conversation's stored history, in one space. */
export function sessionQueryKey(spaceId: string | null, id: string): readonly unknown[] {
  return ["chat", "session", id, spaceId];
}

/**
 * The space the host is scoped to, read off the injected scoping headers —
 * the same value they put in `X-Space-Id`. The module has no space store of its
 * own and must not grow one: the host owns that state and publishes it here.
 */
export function spaceIdFromHeaders(getHeaders: GetHeaders | null | undefined): string | null {
  return getHeaders?.()["X-Space-Id"] ?? null;
}

function headers(getHeaders: GetHeaders | null | undefined, json = false): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}

export async function fetchSessions(
  getHeaders: GetHeaders | null | undefined,
): Promise<SessionSummary[]> {
  const res = await fetch("/api/chat/sessions", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load sessions (HTTP ${res.status})`);
  return ((await res.json()) as { data?: SessionSummary[] }).data ?? [];
}

export async function renameSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
  title: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to rename session (HTTP ${res.status})`);
}

export async function deleteSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to delete session (HTTP ${res.status})`);
}

/** Mark the session read server-side (clears `unread`). Idempotent. */
export async function markSessionRead(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}/read`, {
    method: "PUT",
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to mark session read (HTTP ${res.status})`);
}

/** Explicitly stop the server-side producer for an active conversation. */
export async function stopSession(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}/stop`, {
    method: "POST",
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to stop session (HTTP ${res.status})`);
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredMessage {
  id: string;
  content: Record<string, unknown>;
}

/** A conversation as the detail route serves it: history + skill selection. */
export interface SessionHistory {
  messages: UIMessage[];
  skills: ChatSkillSelection;
}

/**
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. A not-yet-persisted session
 * 404s → empty history and the default selection, which is what the server
 * resolves such a session to.
 */
export async function loadHistory(
  getHeaders: GetHeaders | null | undefined,
  id: string,
): Promise<SessionHistory> {
  const res = await fetch(`/api/chat/sessions/${id}`, {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (res.status === 404) return { messages: [], skills: DEFAULT_SKILL_SELECTION };
  if (!res.ok) throw new Error(`Failed to load session (HTTP ${res.status})`);
  const body = (await res.json()) as {
    messages?: StoredMessage[];
    skill_catalogue: boolean;
    pinned_skills: string[];
  };
  return {
    // Row `id` LAST: a stray `id` inside a stored `content` must not win.
    messages: (body.messages ?? []).map((e) => ({ ...e.content, id: e.id }) as UIMessage),
    skills: { skillCatalogue: body.skill_catalogue, pinnedSkills: body.pinned_skills },
  };
}

/** The fields read off an `OrgPackageItem` row of the space's skill listing. */
interface SkillListRow {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
}

/** The space's skills, the catalogue the picker pins from. */
export async function fetchSkills(getHeaders: GetHeaders | null | undefined): Promise<SkillHint[]> {
  const res = await fetch("/api/packages/skills", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load skills (HTTP ${res.status})`);
  const body = (await res.json()) as { data: SkillListRow[] };
  return body.data.map((row) => ({
    package_id: row.id,
    display_name: row.name,
    description: row.description,
    version: row.version,
  }));
}

/** The selection write in flight per session, settled whatever it answered. */
const skillWrites = new Map<string, Promise<void>>();

/** The turn reads the selection off the row, so a send must not overtake the write. */
export function skillWriteSettled(sessionId: string): Promise<void> {
  return skillWrites.get(sessionId) ?? Promise.resolve();
}

/** Works on an id with no row yet — the route creates it as turn one would. */
export function putSessionSkills(
  getHeaders: GetHeaders | null | undefined,
  sessionId: string,
  selection: ChatSkillSelection,
): Promise<void> {
  const write = writeSessionSkills(getHeaders, sessionId, selection);
  const settled = write.then(
    () => {},
    () => {},
  );
  skillWrites.set(sessionId, settled);
  void settled.then(() => {
    if (skillWrites.get(sessionId) === settled) skillWrites.delete(sessionId);
  });
  return write;
}

async function writeSessionSkills(
  getHeaders: GetHeaders | null | undefined,
  sessionId: string,
  selection: ChatSkillSelection,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/skills`, {
    method: "PUT",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify({
      skill_catalogue: selection.skillCatalogue,
      pinned_skills: selection.pinnedSkills,
    }),
  });
  if (!res.ok) throw new Error(`Failed to save chat skills (HTTP ${res.status})`);
}
