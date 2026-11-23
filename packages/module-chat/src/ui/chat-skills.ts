// SPDX-License-Identifier: Apache-2.0

// The skill picker's pure rules: the conversation's skills as the server serves them, the user's
// selection written over them, and what each row and gauge shows.

import { parseScopedName } from "@appstrate/core/naming";
import { parseSkillUri } from "@appstrate/core/skill-address";
import type { ChatSkillCommand } from "../commands.ts";
import { SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  DEFAULT_SKILL_SELECTION,
  MAX_PINNED_SKILLS,
  normalizePins,
  type ChatSkillStatus,
  type PinnedSkill,
} from "../skills.ts";
import type { ToolPhase } from "./tool-result.ts";

/** A conversation's skills as the session routes serve them (`skill_discovery`, `pins`). */
export interface StoredSkills {
  skillDiscovery: boolean;
  /** Sorted by id. */
  pins: readonly PinnedSkill[];
}

/** A conversation the server does not hold yet: discovery on, no pin. */
export const DEFAULT_STORED_SKILLS: StoredSkills = {
  skillDiscovery: DEFAULT_SKILL_SELECTION.skillDiscovery,
  pins: [],
};

/** What the user chooses, as the PATCH (or the first turn) sends it: the full set of pins. */
export interface SkillSelection {
  skillDiscovery: boolean;
  pins: readonly string[];
}

export const pinIds = (skills: StoredSkills): string[] => skills.pins.map((pin) => pin.id);

export function selectionOf(skills: StoredSkills): SkillSelection {
  return { skillDiscovery: skills.skillDiscovery, pins: pinIds(skills) };
}

/** `stored` with `selection` written: a kept pin keeps its verdict, a new one has none yet. */
export function withSelection(stored: StoredSkills, selection: SkillSelection): StoredSkills {
  const held = new Map(stored.pins.map((pin) => [pin.id, pin]));
  return {
    skillDiscovery: selection.skillDiscovery,
    pins: normalizePins(selection.pins).map(
      (id) => held.get(id) ?? { id, status: null, chars: null },
    ),
  };
}

/** `selection` with `id` pinned (`on`) or unpinned. */
export function withPin(selection: SkillSelection, id: string, on: boolean): SkillSelection {
  return {
    ...selection,
    pins: on
      ? normalizePins([...selection.pins, id])
      : selection.pins.filter((other) => other !== id),
  };
}

/** The package ids of the skills a draft cites with a skill directive, each once. */
export function citedSkillIds(draft: string): string[] {
  return [
    ...new Set(directivesOf(draft).flatMap((d) => (d.type === SKILL_DIRECTIVE ? [d.id] : []))),
  ];
}

/** Whether restoring the default selection (discovery on, no pin) changes anything. */
export function canResetSkills(skills: StoredSkills): boolean {
  return !skills.skillDiscovery || skills.pins.length > 0;
}

export interface EffectiveSkills {
  /** The pinned skills, then those the draft cites: the client's one place the cap is counted. */
  ids: readonly string[];
  cited: ReadonlySet<string>;
  atCap: boolean;
  overCap: boolean;
}

export function effectiveSkills(
  pinned: readonly string[],
  cited: readonly string[],
): EffectiveSkills {
  const ids = [...new Set([...pinned, ...cited])];
  return {
    ids,
    cited: new Set(cited),
    atCap: ids.length >= MAX_PINNED_SKILLS,
    overCap: ids.length > MAX_PINNED_SKILLS,
  };
}

export type SkillRefusal = Exclude<ChatSkillStatus, "injected">;

/**
 * A skill's place in the conversation: `off` (not pinned), `pending` (pinned, no turn judged it
 * since), or the last turn's verdict. Only the server says a skill is loaded.
 */
export type SkillRowState =
  { kind: "off" | "pending" | "loaded" } | { kind: "refused"; reason: SkillRefusal };

export function skillRowState(skills: StoredSkills, id: string): SkillRowState {
  const pin = skills.pins.find((p) => p.id === id);
  if (!pin) return { kind: "off" };
  if (pin.status === null) return { kind: "pending" };
  return pin.status === "injected" ? { kind: "loaded" } : { kind: "refused", reason: pin.status };
}

/** Whether a skill is in the model's context, or will be on the next turn. */
export function loadsSkill(state: SkillRowState, cited: boolean): boolean {
  return state.kind === "loaded" || state.kind === "pending" || (state.kind === "off" && cited);
}

/** The catalogue's rows, then every pin missing from it (`available: false`), so it can be removed. */
export function skillPickerRows(
  catalogue: readonly ChatSkillCommand[],
  pinned: readonly string[],
): { skill: ChatSkillCommand; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.id));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({
      skill: {
        id,
        name: parseScopedName(id)?.name ?? id,
        description: "",
        version: null,
        bytes: null,
      },
      available: false,
    })),
  ];
}

export interface SkillBudget {
  /** Characters the skills take: a loaded pin's `chars`, the catalogue's `bytes` for the others. */
  used: number;
  max: number;
}

/**
 * The share of the pins' budget the conversation takes on its next turn: every loaded pin as the
 * last turn read it, and every pending or cited skill at its listed size (an upper bound).
 */
export function skillBudget(
  skills: StoredSkills,
  effective: EffectiveSkills,
  bytesOf: (id: string) => number | null,
): SkillBudget {
  let used = 0;
  for (const id of effective.ids) {
    const state = skillRowState(skills, id);
    if (state.kind === "loaded") used += skills.pins.find((p) => p.id === id)?.chars ?? 0;
    else if (state.kind !== "refused") used += bytesOf(id) ?? 0;
  }
  return { used, max: CHAT_SKILLS_CONTENT_BUDGET_CHARS };
}

/** Whether pinning a skill of `bytes` would take the budget past its limit. */
export function exceedsBudget(budget: SkillBudget, bytes: number | null): boolean {
  return bytes !== null && budget.used + bytes > budget.max;
}

const SKILL_DEFINITION = "SKILL.md";

/** The skill a read of its `SKILL.md` reads (`read_resource` or `read`); `null` for any other read. */
export function skillLoadOf(
  args: Record<string, unknown> | undefined,
): { packageId: string; name: string } | null {
  const uri = args?.uri;
  const address = typeof uri === "string" ? parseSkillUri(uri) : null;
  if (!address || address.path !== SKILL_DEFINITION) return null;
  return { packageId: address.packageId, name: address.name };
}

/** What a `SKILL.md` read did: it serves the turn that read it, and pins nothing. */
export type SkillLoadState = "running" | "read" | "error";

export function skillLoadState(phase: ToolPhase): SkillLoadState {
  if (phase === "error") return "error";
  return phase === "success" ? "read" : "running";
}
