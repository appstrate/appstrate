// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation's skill selection — transport, cache keys, and the pure
 * rules the picker and its hook share.
 *
 * Two server surfaces back it: `GET /api/chat/skills` (what CAN be pinned: the
 * platform defaults plus the space catalogue) and
 * `PUT /api/chat/sessions/:id/skills` (what IS pinned, plus the discovery
 * mode). The read is space-scoped, the write is session-scoped, and neither
 * goes through the shell's typed client — module-chat talks to its own routes
 * the way `sessions.ts` does.
 *
 * Everything below the transport is PURE and lives here rather than in the
 * component: normalisation, the pin toggle, the optimistic cache patch and the
 * write coalescer are the parts that can be wrong in a way React cannot show
 * you, so they are the parts that get tests.
 *
 * This file is a LEAF: `sessions.ts` imports it (its history payload carries
 * the selection), never the other way round.
 */

import type { UIMessage } from "ai";
import {
  DEFAULT_SKILL_DISCOVERY,
  MAX_PINNED_SKILLS,
  SKILL_DISCOVERY_MODES,
  type SkillDiscovery,
} from "../skills.ts";

export { MAX_PINNED_SKILLS };
import type { GetHeaders } from "./runtime-context.ts";

/**
 * One pinnable skill, exactly as `GET /api/chat/skills` projects it. `source`
 * is what the picker groups on: `platform` skills are indexed by default in
 * `auto` and `on_demand`, `space` ones only through the catalogue or a pin.
 */
export interface ChatSkillEntry {
  package_id: string;
  display_name: string;
  description: string;
  version: string | null;
  source: "platform" | "space";
}

/** The per-session choice: how much to index, and what to always index. */
export interface SessionSkillSelection {
  discovery: SkillDiscovery;
  pinned: string[];
}

/**
 * A conversation's stored history plus its skill selection — one GET, one
 * cache entry. The two travel together because they arrive together
 * (`GET /api/chat/sessions/:id`), and splitting them would give the picker a
 * second request whose answer could disagree with the one the thread mounted.
 */
export interface SessionHistory {
  messages: UIMessage[];
  skills: SessionSkillSelection;
}

/** Prefix every chat-skill-catalogue key starts with — a space-scoped list. */
const CHAT_SKILLS_QUERY_KEY = ["chat", "skills"] as const;

/**
 * The pinnable-skill catalogue of ONE space. Space-scoped for the same reason
 * `sessionsQueryKey` is: the route reads `X-Space-Id`, so a key without it
 * would serve another space's catalogue from cache.
 */
export function chatSkillsQueryKey(spaceId: string | null): readonly unknown[] {
  return [...CHAT_SKILLS_QUERY_KEY, spaceId];
}

/** What a session with no row yet reads: index everything, pin nothing. */
export function defaultSkillSelection(): SessionSkillSelection {
  return { discovery: DEFAULT_SKILL_DISCOVERY, pinned: [] };
}

/**
 * A discovery mode off the wire or out of an optimistic patch. Checked rather
 * than trusted — an unknown mode degrades to the default, the same rule the
 * server-side resolver applies (`../skills.ts`).
 */
export function normalizeDiscovery(value: unknown): SkillDiscovery {
  return SKILL_DISCOVERY_MODES.includes(value as SkillDiscovery)
    ? (value as SkillDiscovery)
    : DEFAULT_SKILL_DISCOVERY;
}

/**
 * The pin set as the UI and the wire both want it: strings only, deduped,
 * sorted, capped. Sorted because the list is rendered and diffed, and an
 * insertion-ordered set would make two equal selections look different.
 */
export function normalizePinned(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort().slice(0, MAX_PINNED_SKILLS);
}

/**
 * Pin/unpin one id. Returns the PREVIOUS set unchanged when the cap would be
 * exceeded, so the caller can detect the refusal by identity.
 */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  const set = new Set(pinned);
  if (set.has(packageId)) set.delete(packageId);
  else if (set.size >= MAX_PINNED_SKILLS) return pinned as string[];
  else set.add(packageId);
  return normalizePinned([...set]);
}

/**
 * The optimistic cache patch: the session entry with a new selection, keeping
 * the messages. `prev` is `undefined` for a conversation whose first message
 * has not been sent yet (no row, so no GET) — pinning before the first turn is
 * supported server-side, so it must be supported here: we seed an empty
 * history rather than dropping the write.
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
 * Group by source, platform first. The server already sorts within each group
 * (by package id), so this partitions and never re-sorts — a second ordering
 * rule here could only disagree with the one the prompt's index uses.
 */
export function groupSkillsBySource(skills: readonly ChatSkillEntry[]): SkillGroup[] {
  const groups: SkillGroup[] = [
    { source: "platform", skills: skills.filter((s) => s.source === "platform") },
    { source: "space", skills: skills.filter((s) => s.source === "space") },
  ];
  return groups.filter((g) => g.skills.length > 0);
}

/**
 * Serialises writes to ONE session's selection: at most one PUT in flight, and
 * the newest selection wins.
 *
 * Toggling three checkboxes in a second must not race three PUTs whose
 * completion order decides the stored set — the last one the user asked for is
 * the one that must land. Queue depth is 1 on purpose: an intermediate state
 * nobody looked at is not worth a round trip.
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

function headers(getHeaders: GetHeaders | null | undefined, json = false): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...getHeaders?.() };
}

/** The skills this caller may pin in the current space — platform, then space. */
export async function fetchChatSkills(
  getHeaders: GetHeaders | null | undefined,
): Promise<ChatSkillEntry[]> {
  const res = await fetch("/api/chat/skills", {
    credentials: "include",
    headers: headers(getHeaders),
  });
  if (!res.ok) throw new Error(`Failed to load chat skills (HTTP ${res.status})`);
  return ((await res.json()) as { skills?: ChatSkillEntry[] }).skills ?? [];
}

/**
 * Replace the conversation's mode + pin set. Works on an id with no row yet —
 * the route creates the session exactly like the first turn does — so the
 * picker is usable before the first message.
 */
export async function putSessionSkills(
  getHeaders: GetHeaders | null | undefined,
  sessionId: string,
  selection: SessionSkillSelection,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/skills`, {
    method: "PUT",
    credentials: "include",
    headers: headers(getHeaders, true),
    body: JSON.stringify({
      skill_discovery: selection.discovery,
      pinned_skills: normalizePinned(selection.pinned),
    }),
  });
  if (!res.ok) throw new Error(`Failed to save chat skills (HTTP ${res.status})`);
}
