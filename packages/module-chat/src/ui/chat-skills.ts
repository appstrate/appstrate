// SPDX-License-Identifier: Apache-2.0

/**
 * The skill picker's pure rules. The server holds the conversation's skills (`StoredSkills`); the
 * client holds only what the user changed since it last read them (`ChatSkillChanges`), and sends
 * those changes, never a full set: a stale client cannot drop a pin the server added.
 */

import { parseScopedName } from "@appstrate/core/naming";
import { parseSkillUri } from "@appstrate/core/skill-uri";
import type { ChatSkillCommand } from "../commands.ts";
import { SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import {
  DEFAULT_SKILL_SELECTION,
  MAX_PINNED_SKILLS,
  applySkillChanges,
  type ChatSkillChanges,
  type PinnedSkill,
  type PinnedSkillStatus,
} from "../skills.ts";

/** A conversation's skills as the session routes serve them (`skill_discovery`, `skills`). */
export interface StoredSkills {
  skillDiscovery: boolean;
  /** Sorted by id. */
  pins: readonly PinnedSkill[];
}

/** A conversation the server does not hold yet: discovery on, no pin. */
export const DEFAULT_STORED_SKILLS: StoredSkills = {
  skillDiscovery: DEFAULT_SKILL_SELECTION.skillDiscovery,
  pins: DEFAULT_SKILL_SELECTION.pinnedSkills.map((id) => ({ id, source: "user", status: null })),
};

export const NO_SKILL_CHANGES: ChatSkillChanges = { pin: [], unpin: [] };

/** Whether `changes` carries anything for a turn to send. */
export function hasSkillChanges(changes: ChatSkillChanges): boolean {
  return changes.skillDiscovery !== undefined || changes.pin.length > 0 || changes.unpin.length > 0;
}

/** The conversation's skills as the composer shows them: the server's, the user's changes applied. */
export interface ConversationSkills {
  skillDiscovery: boolean;
  /** Pinned once the changes apply, sorted: with the draft's citations, what the cap counts. */
  pinned: readonly string[];
  /** The server's pins, by id: their source and the verdict of the last turn. */
  stored: ReadonlyMap<string, PinnedSkill>;
  /** Pinned by a change the server has not applied yet: the next turn loads them. */
  pending: ReadonlySet<string>;
}

export function conversationSkills(
  stored: StoredSkills,
  changes: ChatSkillChanges,
): ConversationSkills {
  const byId = new Map(stored.pins.map((pin) => [pin.id, pin]));
  return {
    skillDiscovery: changes.skillDiscovery ?? stored.skillDiscovery,
    pinned: applySkillChanges([...byId.keys()], changes),
    stored: byId,
    pending: new Set(changes.pin),
  };
}

/**
 * What a change is made against: the server's skills as last read, and the changes the turn in
 * flight carries. A change the server state already shows is not recorded, unless it undoes one
 * in flight: the server is about to apply that one, and the undo must reach it.
 */
export interface SkillChangeBase {
  stored: StoredSkills;
  inFlight: ChatSkillChanges | null;
}

const without = (ids: readonly string[], id: string) => ids.filter((other) => other !== id);
const withId = (ids: readonly string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);

/** `changes` with `id` pinned (`on`) or unpinned, from the panel. */
export function changePin(
  changes: ChatSkillChanges,
  id: string,
  on: boolean,
  { stored, inFlight }: SkillChangeBase,
): ChatSkillChanges {
  const held = stored.pins.some((pin) => pin.id === id);
  if (on) {
    const record = !held || !!inFlight?.unpin.includes(id);
    return {
      ...changes,
      pin: record ? withId(changes.pin, id) : changes.pin,
      unpin: without(changes.unpin, id),
    };
  }
  const record = held || !!inFlight?.pin.includes(id);
  return {
    ...changes,
    pin: without(changes.pin, id),
    unpin: record ? withId(changes.unpin, id) : changes.unpin,
  };
}

/** `changes` with discovery `on` or off. */
export function changeDiscovery(
  changes: ChatSkillChanges,
  on: boolean,
  { stored, inFlight }: SkillChangeBase,
): ChatSkillChanges {
  const { skillDiscovery: _previous, ...rest } = changes;
  const undoesInFlight = inFlight?.skillDiscovery !== undefined && inFlight.skillDiscovery !== on;
  return on === stored.skillDiscovery && !undoesInFlight ? rest : { ...rest, skillDiscovery: on };
}

/**
 * `changes` with a skill the sent message cites pinned. Recorded whatever the server holds: a
 * citation is the user's act (it makes an assistant's pin theirs), and a pin is idempotent.
 */
export function citeSkill(changes: ChatSkillChanges, id: string): ChatSkillChanges {
  return { ...changes, pin: withId(changes.pin, id), unpin: without(changes.unpin, id) };
}

/** `changes` without each entry of `removed`, by value. */
export function subtractSkillChanges(
  changes: ChatSkillChanges,
  removed: ChatSkillChanges,
): ChatSkillChanges {
  const { skillDiscovery, ...rest } = changes;
  return {
    ...rest,
    ...(skillDiscovery !== undefined &&
      skillDiscovery !== removed.skillDiscovery && { skillDiscovery }),
    pin: changes.pin.filter((id) => !removed.pin.includes(id)),
    unpin: changes.unpin.filter((id) => !removed.unpin.includes(id)),
  };
}

/** `under`, then `over` applied on top of it: an id in `over` takes `over`'s side. */
export function layerSkillChanges(
  under: ChatSkillChanges,
  over: ChatSkillChanges,
): ChatSkillChanges {
  const skillDiscovery = over.skillDiscovery ?? under.skillDiscovery;
  return {
    ...(skillDiscovery !== undefined && { skillDiscovery }),
    pin: [...new Set([...under.pin.filter((id) => !over.unpin.includes(id)), ...over.pin])],
    unpin: [...new Set([...under.unpin.filter((id) => !over.pin.includes(id)), ...over.unpin])],
  };
}

/** Back to the default selection: discovery on, every pin removed. */
export function resetSkillChanges(
  changes: ChatSkillChanges,
  pinned: readonly string[],
  base: SkillChangeBase,
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

/**
 * Whether restoring the default selection changes anything the user can see: a pinned skill the
 * draft does not cite (a cited one stays checked by its chip), or discovery off.
 */
export function canResetSkills(skills: ConversationSkills, cited: readonly string[]): boolean {
  return !skills.skillDiscovery || skills.pinned.some((id) => !cited.includes(id));
}

/**
 * The skills the conversation will load: the pinned ones and those the draft cites (sending pins
 * them). The ONE place the pin cap is counted: the panel, the pill, the `/` menu and the send all
 * read it.
 */
export function effectiveSkills(pinned: readonly string[], cited: readonly string[]) {
  const ids = [...new Set([...pinned, ...cited])];
  return {
    ids,
    /** Cited in the draft: the composer holds them, the panel cannot uncheck them. */
    cited: new Set(cited),
    atCap: ids.length >= MAX_PINNED_SKILLS,
    overCap: ids.length > MAX_PINNED_SKILLS,
  };
}

/** Why the last turn left a pin out of its context. */
type SkillRefusal = Exclude<PinnedSkillStatus, "injected">;

/**
 * What a picker row shows, the server's word first: only it says a skill is loaded.
 * - `cited`: the draft cites it; checked and locked, the chip in the message is what drops it.
 * - `next`: the next turn loads it (a pin the user added, or one no turn evaluated yet).
 * - `loaded`: the last turn injected it, pinned by `source`.
 * - `refused`: pinned, but the last turn left it out, for `reason`.
 * - `off`: not pinned.
 */
export type SkillRowState =
  | { kind: "cited" | "next" | "off" }
  | { kind: "loaded"; source: PinnedSkill["source"] }
  | { kind: "refused"; reason: SkillRefusal };

export function skillRowState(
  skills: ConversationSkills,
  id: string,
  cited: ReadonlySet<string>,
): SkillRowState {
  if (cited.has(id)) return { kind: "cited" };
  if (!skills.pinned.includes(id)) return { kind: "off" };
  // A pending pin is the user's latest word: the stored verdict predates it.
  if (skills.pending.has(id)) return { kind: "next" };
  const pin = skills.stored.get(id);
  if (!pin || pin.status === null) return { kind: "next" };
  return pin.status === "injected"
    ? { kind: "loaded", source: pin.source }
    : { kind: "refused", reason: pin.status };
}

/** Whether a row's skill is in the model's context, or will be on the next turn. */
export function loadsSkill(state: SkillRowState): boolean {
  return state.kind !== "off" && state.kind !== "refused";
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`, named by its package's bare name), so a dead pin can
 * still be removed.
 */
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

/** The `SKILL.md` that defines a skill: the file whose read loads it. */
const SKILL_DEFINITION = "SKILL.md";

/**
 * The skill a resource read (`read_resource`, or the forwarded `read`) loads, named by its served
 * frontmatter `name`: the assistant loads a skill by reading its `SKILL.md`. `null` when the read
 * names anything else.
 */
export function skillLoadOf(
  args: Record<string, unknown> | undefined,
): { packageId: string; name: string } | null {
  const uri = args?.uri;
  const address = typeof uri === "string" ? parseSkillUri(uri) : null;
  if (!address || address.path !== SKILL_DEFINITION) return null;
  // The served frontmatter `name`: what the `/` menu inserts, so the user's chip reads the same.
  return { packageId: address.packageId, name: address.name };
}
