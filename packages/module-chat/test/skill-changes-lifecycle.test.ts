// SPDX-License-Identifier: Apache-2.0

/**
 * The lifecycle of the user's skill changes (`createSkillChanges`, the state machine behind
 * `useConversationSkills`): taken by a turn, dropped once an accepted turn has ended and the detail
 * was read again, kept when the turn was refused, never losing a change made while it ran.
 */

import { describe, expect, it } from "bun:test";
import type { ChatSkillChanges, PinnedSkill } from "../src/skills.ts";
import {
  NO_SKILL_CHANGES,
  changePin,
  conversationSkills,
  skillRowState,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";
import { createSkillChanges } from "../src/ui/use-conversation-skills.ts";

const stored = (pins: PinnedSkill[]): StoredSkills => ({ skillDiscovery: true, pins });
const assistantPin: PinnedSkill = { id: "@a/x", source: "assistant", status: "injected" };

/** Toggles `id` from the panel against `server`, as the hook does. */
function toggle(store: ReturnType<typeof createSkillChanges>, server: StoredSkills, id: string) {
  store.change((current, inFlight) =>
    changePin(current, id, !conversationSkills(server, current).pinned.includes(id), {
      stored: server,
      inFlight,
    }),
  );
}

/** One turn: take, answer, end, settle (the re-read done). */
function turn(store: ReturnType<typeof createSkillChanges>, accepted: boolean) {
  const sent = store.take();
  store.answered(accepted);
  const ended = store.end()!;
  return { sent, ended };
}

describe("skill changes across a turn", () => {
  it("drops what an accepted turn sent once it has ended and the detail was read", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    const { sent, ended } = turn(store, true);
    expect(sent).toEqual({ pin: ["@a/new"], unpin: [] });
    expect(ended.accepted).toBe(true);
    // Until the re-read the change still shows.
    expect(store.get().pin).toEqual(["@a/new"]);
    ended.settle();
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
  });

  it("keeps the changes of a turn refused or failed without an answer", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    turn(store, false).ended.settle();
    expect(store.get().pin).toEqual(["@a/new"]);

    // No answer at all (a network failure): `answered` is never called.
    store.take();
    store.end()!.settle();
    expect(store.get().pin).toEqual(["@a/new"]);
  });

  it("keeps a change made while the turn ran", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    const sent = store.take();
    store.answered(true);
    toggle(store, stored([]), "@a/later");
    store.end()!.settle();
    expect(sent!.pin).toEqual(["@a/new"]);
    expect(store.get().pin).toEqual(["@a/later"]);
  });

  it("never lets the settling of one turn clear the turn sent after it, even with equal changes", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    const first = turn(store, false).ended;
    // A second turn sends the same (kept) changes before the first one's re-read lands.
    const second = store.take();
    first.settle();
    expect(second).toEqual({ pin: ["@a/new"], unpin: [] });
    // The second turn is still in flight: unchecking now records the undo it must carry.
    toggle(store, stored([]), "@a/new");
    expect(store.get()).toEqual({ pin: [], unpin: ["@a/new"] });
    store.answered(true);
    store.end()!.settle();
    expect(store.get()).toEqual({ pin: [], unpin: ["@a/new"] });
  });

  it("never replays an unpin the server applied, when the assistant re-pins the skill in that turn", () => {
    const store = createSkillChanges();
    toggle(store, stored([assistantPin]), "@a/x");
    const { sent, ended } = turn(store, true);
    expect(sent).toEqual({ pin: [], unpin: ["@a/x"] });
    // The turn applied the unpin, then the assistant loaded the skill again: the re-read holds it.
    ended.settle();
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
    expect(store.take()).toBeUndefined();
    const after = conversationSkills(stored([assistantPin]), store.get());
    expect(skillRowState(after, "@a/x", new Set())).toEqual({
      kind: "loaded",
      source: "assistant",
    });
  });

  it("re-checking during an in-flight unpin records the pin and shows it as next", () => {
    const store = createSkillChanges();
    const server = stored([assistantPin]);
    toggle(store, server, "@a/x");
    store.take();
    toggle(store, server, "@a/x");
    const current: ChatSkillChanges = store.get();
    expect(current).toEqual({ pin: ["@a/x"], unpin: [] });
    expect(skillRowState(conversationSkills(server, current), "@a/x", new Set())).toEqual({
      kind: "next",
    });
  });

  it("ends no turn when none was sent in this mount (a resumed one)", () => {
    expect(createSkillChanges().end()).toBeNull();
  });
});
