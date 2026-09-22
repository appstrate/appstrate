// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation's skill selection: the space catalogue it is picked from,
 * the write that stores it, and the pure rules the picker applies.
 */

import { MAX_PINNED_SKILLS, type ChatSkillSelection, type SkillHint } from "../skills.ts";
import { requestHeaders } from "./request-headers.ts";
import type { GetHeaders } from "./runtime-context.ts";

/** The fields read off an `OrgPackageItem` listing row. */
interface SkillListRow {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
}

/** Space-scoped: the listing reads `X-Space-Id`, so a bare key crosses spaces. */
export function chatSkillsQueryKey(spaceId: string | null): readonly unknown[] {
  return ["chat", "skills", spaceId];
}

export const SKILLS_STALE_MS = 60_000;

/** Pin/unpin, sorted. Returns `pinned` ITSELF at the cap, so refusal is detectable. */
export function togglePinned(pinned: readonly string[], packageId: string): readonly string[] {
  const set = new Set(pinned);
  if (set.has(packageId)) set.delete(packageId);
  else if (set.size >= MAX_PINNED_SKILLS) return pinned;
  else set.add(packageId);
  return [...set].sort();
}

/** A picker row; `available: false` is a pin the catalogue no longer lists. */
export interface SkillPickerRow {
  skill: SkillHint;
  available: boolean;
}

/** The catalogue, then every pin missing from it, so a dead pin can still be removed. */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
): SkillPickerRow[] {
  const listed = new Set(catalogue.map((skill) => skill.package_id));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({ skill: { package_id: id }, available: false })),
  ];
}

export interface SkillsWriteOutcome {
  sent: ChatSkillSelection;
  ok: boolean;
  /** No newer selection is queued behind this one. */
  idle: boolean;
}

/**
 * The picker's state after a write settles. A failure reverts to the last
 * confirmed selection — unless a newer write is queued, which then decides.
 */
export function settleSkillsWrite(
  confirmed: ChatSkillSelection,
  outcome: SkillsWriteOutcome,
): { confirmed: ChatSkillSelection; revert: boolean } {
  if (outcome.ok) return { confirmed: outcome.sent, revert: false };
  return { confirmed, revert: outcome.idle };
}

/**
 * One PUT in flight, newest wins: racing PUTs would let completion order
 * decide the stored set. Queue depth 1 — an unseen intermediate is not sent.
 */
export interface SkillsWriter {
  write(selection: ChatSkillSelection): void;
}

export function createSkillsWriter(
  put: (selection: ChatSkillSelection) => Promise<void>,
  onSettled?: (outcome: SkillsWriteOutcome) => void,
): SkillsWriter {
  let busy = false;
  let queued: ChatSkillSelection | null = null;

  const run = (selection: ChatSkillSelection): void => {
    busy = true;
    void put(selection).then(
      () => finish(selection, true),
      () => finish(selection, false),
    );
  };

  const finish = (sent: ChatSkillSelection, ok: boolean): void => {
    busy = false;
    const next = queued;
    queued = null;
    onSettled?.({ sent, ok, idle: next === null });
    if (next) run(next);
  };

  return {
    write(selection) {
      if (busy) queued = selection;
      else run(selection);
    },
  };
}

/** The space's listed skills. A 403 (no `skills:read`) means nothing to offer. */
export async function fetchChatSkills(
  getHeaders: GetHeaders | null | undefined,
): Promise<SkillHint[]> {
  const res = await fetch("/api/packages/skills", {
    credentials: "include",
    headers: requestHeaders(getHeaders),
  });
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(`Failed to load skills (HTTP ${res.status})`);
  const body = (await res.json()) as { data: SkillListRow[] };
  return body.data.map((row) => ({
    package_id: row.id,
    display_name: row.name,
    description: row.description,
    version: row.version,
  }));
}

/** Works on an id with no row yet — the route creates it as turn one would. */
export async function putSessionSkills(
  getHeaders: GetHeaders | null | undefined,
  sessionId: string,
  selection: ChatSkillSelection,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/skills`, {
    method: "PUT",
    credentials: "include",
    headers: requestHeaders(getHeaders, true),
    body: JSON.stringify({
      skill_catalogue: selection.catalogue,
      pinned_skills: selection.pinned,
    }),
  });
  if (!res.ok) throw new Error(`Failed to save chat skills (HTTP ${res.status})`);
}
