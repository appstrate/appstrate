// SPDX-License-Identifier: Apache-2.0

// The skill picker's pure rules. A turn sends the user's changes: see `ChatSkillChanges`.

import { parseScopedName } from "@appstrate/core/naming";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { parseSkillUri } from "@appstrate/core/skill-address";
import type { ChatSkillCommand } from "../commands.ts";
import { SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import {
  DEFAULT_SKILL_SELECTION,
  MAX_PINNED_SKILLS,
  applySkillChanges,
  type ChatSkillChanges,
  type ChatSkillStatus,
  type PinnedSkill,
} from "../skills.ts";
import type { ToolPhase } from "./tool-result.ts";

/** A conversation's skills as the session routes serve them (`skill_discovery`, `skills`). */
export interface StoredSkills {
  skillDiscovery: boolean;
  pins: readonly PinnedSkill[];
}

/** A conversation the server does not hold yet: discovery on, no pin. */
export const DEFAULT_STORED_SKILLS: StoredSkills = {
  skillDiscovery: DEFAULT_SKILL_SELECTION.skillDiscovery,
  pins: [],
};

export const NO_SKILL_CHANGES: ChatSkillChanges = { pin: [], unpin: [] };

/** Whether `changes` carries anything for a turn to send. */
export function hasSkillChanges(changes: ChatSkillChanges): boolean {
  return changes.skillDiscovery !== undefined || changes.pin.length > 0 || changes.unpin.length > 0;
}

/** `inFlight`: carried by the unanswered turn; `local`: made since, over `inFlight` applied. */
export interface SkillLayers {
  inFlight: ChatSkillChanges;
  local: ChatSkillChanges;
}

export const NO_SKILL_LAYERS: SkillLayers = { inFlight: NO_SKILL_CHANGES, local: NO_SKILL_CHANGES };

/** `older` then `newer`: for a skill or the discovery switch both change, `newer` wins. */
export function mergeSkillChanges(
  older: ChatSkillChanges,
  newer: ChatSkillChanges,
): ChatSkillChanges {
  const decided = new Set([...newer.pin, ...newer.unpin]);
  const kept = (ids: readonly string[]) => ids.filter((id) => !decided.has(id));
  const skillDiscovery = newer.skillDiscovery ?? older.skillDiscovery;
  return {
    ...(skillDiscovery !== undefined && { skillDiscovery }),
    pin: [...kept(older.pin), ...newer.pin],
    unpin: [...kept(older.unpin), ...newer.unpin],
  };
}

/** The conversation's skills as the composer shows them: the server's, the user's changes applied. */
export interface ConversationSkills {
  skillDiscovery: boolean;
  /** Pinned once the changes apply, sorted. */
  pinned: readonly string[];
  /** The server's pins with `inFlight` applied, by id. */
  stored: ReadonlyMap<string, PinnedSkill>;
  /** Pinned by a change the server has not applied yet. */
  pending: ReadonlySet<string>;
  /** Held by the server and unchecked since: removed by the next turn. */
  unpinning: ReadonlySet<string>;
}

export function conversationSkills(stored: StoredSkills, layers: SkillLayers): ConversationSkills {
  const base = withAppliedChanges(stored, layers.inFlight);
  const byId = new Map(base.pins.map((pin) => [pin.id, pin]));
  return {
    skillDiscovery: layers.local.skillDiscovery ?? base.skillDiscovery,
    pinned: applySkillChanges([...byId.keys()], layers.local),
    stored: byId,
    pending: new Set([...layers.inFlight.pin, ...layers.local.pin]),
    unpinning: new Set(layers.local.unpin.filter((id) => byId.has(id))),
  };
}

const without = (ids: readonly string[], id: string) => ids.filter((other) => other !== id);
const withId = (ids: readonly string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);

/** `changes` with `id` pinned (`on`) or unpinned; a change `base` already shows is not recorded. */
export function changePin(
  changes: ChatSkillChanges,
  id: string,
  on: boolean,
  base: StoredSkills,
): ChatSkillChanges {
  const held = base.pins.some((pin) => pin.id === id);
  if (on)
    return {
      ...changes,
      pin: held ? changes.pin : withId(changes.pin, id),
      unpin: without(changes.unpin, id),
    };
  return {
    ...changes,
    pin: without(changes.pin, id),
    unpin: held ? withId(changes.unpin, id) : changes.unpin,
  };
}

/** `changes` with discovery `on` or off, over `base`. */
export function changeDiscovery(
  changes: ChatSkillChanges,
  on: boolean,
  base: StoredSkills,
): ChatSkillChanges {
  const { skillDiscovery: _previous, ...rest } = changes;
  return on === base.skillDiscovery ? rest : { ...rest, skillDiscovery: on };
}

/** `changes` with a cited skill pinned, even one held (unlike `changePin`): it becomes the user's. */
export function citeSkill(changes: ChatSkillChanges, id: string): ChatSkillChanges {
  return { ...changes, pin: withId(changes.pin, id), unpin: without(changes.unpin, id) };
}

/** `stored` once the server applied `changes`: a re-pin becomes the user's, a new pin is unjudged. */
export function withAppliedChanges(stored: StoredSkills, changes: ChatSkillChanges): StoredSkills {
  const byId = new Map(stored.pins.map((pin) => [pin.id, pin]));
  return {
    skillDiscovery: changes.skillDiscovery ?? stored.skillDiscovery,
    pins: applySkillChanges([...byId.keys()], changes).map((id): PinnedSkill => {
      const held = byId.get(id);
      if (!held) return { id, source: "user", status: null };
      return changes.pin.includes(id) ? { ...held, source: "user" } : held;
    }),
  };
}

/** Back to the default selection: discovery on, every pin removed. */
export function resetSkillChanges(
  changes: ChatSkillChanges,
  pinned: readonly string[],
  base: StoredSkills,
): ChatSkillChanges {
  return pinned.reduce(
    (next, id) => changePin(next, id, false, base),
    changeDiscovery(changes, true, base),
  );
}

/** The package ids of the skills a draft cites with a skill directive, each once. */
export function citedSkillIds(draft: string): string[] {
  return [
    ...new Set(directivesOf(draft).flatMap((d) => (d.type === SKILL_DIRECTIVE ? [d.id] : []))),
  ];
}

/** Whether restoring the default selection changes anything visible (a cited pin stays checked). */
export function canResetSkills(skills: ConversationSkills, cited: readonly string[]): boolean {
  return !skills.skillDiscovery || skills.pinned.some((id) => !cited.includes(id));
}

/** The pinned skills and those the draft cites: the client's one place the pin cap is counted. */
export function effectiveSkills(pinned: readonly string[], cited: readonly string[]) {
  const ids = [...new Set([...pinned, ...cited])];
  return {
    ids,
    cited: new Set(cited),
    atCap: ids.length >= MAX_PINNED_SKILLS,
    overCap: ids.length > MAX_PINNED_SKILLS,
  };
}

type SkillRefusal = Exclude<ChatSkillStatus, "injected">;

/**
 * What a picker row shows; only the server says a skill is loaded. `cited`: locked by the draft;
 * `next`: no turn judged it yet; `loaded` / `refused`: the last turn's verdict; `unpin`: held, unchecked, removed by
 * the next turn; `off`: not pinned.
 */
export type SkillRowState =
  | { kind: "cited" | "next" | "unpin" | "off" }
  | { kind: "loaded"; source: PinnedSkill["source"] }
  | { kind: "refused"; reason: SkillRefusal };

export function skillRowState(
  skills: ConversationSkills,
  id: string,
  cited: ReadonlySet<string>,
): SkillRowState {
  if (cited.has(id)) return { kind: "cited" };
  if (!skills.pinned.includes(id)) return { kind: skills.unpinning.has(id) ? "unpin" : "off" };
  if (skills.pending.has(id)) return { kind: "next" };
  const pin = skills.stored.get(id);
  if (!pin || pin.status === null) return { kind: "next" };
  return pin.status === "injected"
    ? { kind: "loaded", source: pin.source }
    : { kind: "refused", reason: pin.status };
}

/** Whether a row's skill is in the model's context, or will be on the next turn. */
export function loadsSkill(state: SkillRowState): boolean {
  return state.kind !== "off" && state.kind !== "unpin" && state.kind !== "refused";
}

/** Whether a checked row's pin is the server's, so unchecking it removes it from the context. */
export function removesFromContext(skills: ConversationSkills, id: string, state: SkillRowState) {
  const held = state.kind === "next" || state.kind === "loaded" || state.kind === "refused";
  return held && skills.stored.has(id) && !skills.pending.has(id);
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
      },
      available: false,
    })),
  ];
}

const SKILL_DEFINITION = "SKILL.md";

/** The skill a read of its `SKILL.md` loads (`read_resource` or `read`); `null` for any other read. */
export function skillLoadOf(
  args: Record<string, unknown> | undefined,
): { packageId: string; name: string } | null {
  const uri = args?.uri;
  const address = typeof uri === "string" ? parseSkillUri(uri) : null;
  if (!address || address.path !== SKILL_DEFINITION) return null;
  return { packageId: address.packageId, name: address.name };
}

/** What a `SKILL.md` read did: `loaded` only when its result carries the server's `skillPinned`. */
export type SkillLoadState = "running" | "loaded" | "readOnly" | "refused";

export function skillLoadState(phase: ToolPhase, result: unknown): SkillLoadState {
  if (phase === "error") return "refused";
  if (phase !== "success") return "running";
  return asRecordOrNull(result)?.skillPinned === true ? "loaded" : "readOnly";
}
