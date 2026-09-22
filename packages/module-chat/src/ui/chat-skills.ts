// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation's skill selection — transport, cache keys, and the pure
 * rules the picker and its hook share.
 *
 * Two server surfaces back it: `GET /api/chat/skills` (what CAN be pinned,
 * space-scoped) and `PUT /api/chat/sessions/:id/skills` (what IS pinned plus
 * the discovery mode, session-scoped). Neither goes through the shell's typed
 * client — module-chat talks to its own routes the way `sessions.ts` does.
 *
 * Everything below the transport is PURE: those are the parts that can be
 * wrong in a way React cannot show you. A LEAF — `sessions.ts` imports it.
 */

import type { UIMessage } from "ai";
import {
  DEFAULT_SKILL_DISCOVERY,
  MAX_PINNED_SKILLS,
  toSkillDiscovery,
  type ChatSkillEntry,
  type SkillDiscovery,
} from "../skills.ts";
import { requestHeaders } from "./request-headers.ts";
import type { GetHeaders } from "./runtime-context.ts";

export type { ChatSkillEntry };

/** The per-session choice: how much to index, and what to always index. */
export interface SessionSkillSelection {
  discovery: SkillDiscovery;
  pinned: string[];
}

/** One GET, one cache entry: a split would let the picker read a stale mode. */
export interface SessionHistory {
  messages: UIMessage[];
  skills: SessionSkillSelection;
}

const CHAT_SKILLS_QUERY_KEY = ["chat", "skills"] as const;

/** Space-scoped: the route reads `X-Space-Id`, so a bare key crosses spaces. */
export function chatSkillsQueryKey(spaceId: string | null): readonly unknown[] {
  return [...CHAT_SKILLS_QUERY_KEY, spaceId];
}

/** The catalogue changes when a package is published or activated — rarely. */
export const SKILLS_STALE_MS = 60_000;

/** What a session with no row yet reads: index everything, pin nothing. */
export function defaultSkillSelection(): SessionSkillSelection {
  return { discovery: DEFAULT_SKILL_DISCOVERY, pinned: [] };
}

/** The SERVER's own narrowing: two "degrades to the default" would drift. */
export const normalizeDiscovery = toSkillDiscovery;

/**
 * Strings only, deduped, sorted, capped — sorted because the list is diffed,
 * and insertion order makes two equal selections look different.
 */
export function normalizePinned(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort().slice(0, MAX_PINNED_SKILLS);
}

/** Pin/unpin. Returns `pinned` ITSELF at the cap, so refusal is detectable. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  const set = new Set(pinned);
  if (set.has(packageId)) set.delete(packageId);
  else if (set.size >= MAX_PINNED_SKILLS) return pinned as string[];
  else set.add(packageId);
  return normalizePinned([...set]);
}

/**
 * The optimistic cache patch. `prev` is `undefined` before the first message
 * (no row, so no GET); pinning then is supported server-side, so seed.
 */
export function withSkillSelection(
  prev: SessionHistory | undefined,
  next: SessionSkillSelection,
): SessionHistory {
  return {
    messages: prev?.messages ?? [],
    skills: { discovery: normalizeDiscovery(next.discovery), pinned: normalizePinned(next.pinned) },
  };
}

/** Skills split into the two groups the picker renders, empty groups dropped. */
export interface SkillGroup {
  source: ChatSkillEntry["source"];
  skills: ChatSkillEntry[];
}

/**
 * Partitions, never re-sorts — the server sorts within each group. An unknown
 * source joins `space`: a mis-grouped row beats an unrenderable one.
 */
export function groupSkillsBySource(skills: readonly ChatSkillEntry[]): SkillGroup[] {
  const groups: SkillGroup[] = [
    { source: "platform", skills: skills.filter((s) => s.source === "platform") },
    { source: "space", skills: skills.filter((s) => s.source !== "platform") },
  ];
  return groups.filter((g) => g.skills.length > 0);
}

/**
 * One PUT in flight per session, newest wins — three checkbox clicks must not
 * race three PUTs whose completion order decides the stored set. Queue depth
 * 1: an intermediate nobody looked at is not worth a round trip.
 */
export interface SkillsWriter {
  write(selection: SessionSkillSelection): void;
}

export function createSkillsWriter(
  put: (selection: SessionSkillSelection) => Promise<void>,
  onSettled?: (error: unknown) => void,
): SkillsWriter {
  let busy = false;
  let queued: SessionSkillSelection | null = null;

  const run = (selection: SessionSkillSelection): void => {
    busy = true;
    void put(selection).then(
      () => finish(undefined),
      (error: unknown) => finish(error),
    );
  };

  const finish = (error: unknown): void => {
    busy = false;
    onSettled?.(error);
    const next = queued;
    queued = null;
    if (next) run(next);
  };

  return {
    write(selection) {
      if (busy) queued = selection;
      else run(selection);
    },
  };
}

/** The skills this caller may pin in the current space — platform, then space. */
export async function fetchChatSkills(
  getHeaders: GetHeaders | null | undefined,
): Promise<ChatSkillEntry[]> {
  const res = await fetch("/api/chat/skills", {
    credentials: "include",
    headers: requestHeaders(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load chat skills (HTTP ${res.status})`);
  return ((await res.json()) as { skills?: ChatSkillEntry[] }).skills ?? [];
}

/** Works on an id with no row yet — the route creates it as turn one would. */
export async function putSessionSkills(
  getHeaders: GetHeaders | null | undefined,
  sessionId: string,
  selection: SessionSkillSelection,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/skills`, {
    method: "PUT",
    credentials: "include",
    headers: requestHeaders(getHeaders, true),
    body: JSON.stringify({
      skill_discovery: selection.discovery,
      pinned_skills: normalizePinned(selection.pinned),
    }),
  });
  if (!res.ok) throw new Error(`Failed to save chat skills (HTTP ${res.status})`);
}
