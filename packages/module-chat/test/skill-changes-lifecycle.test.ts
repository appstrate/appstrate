// SPDX-License-Identifier: Apache-2.0

/**
 * The lifecycle of the user's skill changes (`createSkillChanges`, the state machine behind
 * `useConversationSkills`): taken by a turn; out of what the next turn sends the moment an accepted
 * turn ends, displayed until the detail is read again; kept when the turn was refused; a change
 * made while the turn ran always kept.
 */

import { describe, expect, it } from "bun:test";
import type { PinnedSkill } from "../src/skills.ts";
import {
  NO_SKILL_CHANGES,
  changePin,
  conversationSkills,
  skillRowState,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";
import { createSkillChanges } from "../src/ui/use-conversation-skills.ts";

type Store = ReturnType<typeof createSkillChanges>;

const stored = (pins: PinnedSkill[]): StoredSkills => ({ skillDiscovery: true, pins });
const assistantPin: PinnedSkill = { id: "@a/x", source: "assistant", status: "injected" };

/** Toggles `id` from the panel against `server`, as the hook does: on what the panel shows. */
function toggle(store: Store, server: StoredSkills, id: string) {
  store.change((current, inFlight, shown) =>
    changePin(current, id, !conversationSkills(server, shown).pinned.includes(id), {
      stored: server,
      inFlight,
    }),
  );
}

/** One turn: take, answer, end. */
function turn(store: Store, accepted: boolean) {
  const sent = store.take();
  store.answered(accepted);
  const ended = store.end()!;
  return { sent, ended };
}

describe("skill changes across a turn", () => {
  it("an accepted turn's changes leave the send at once and the display after the re-read", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    const { sent, ended } = turn(store, true);
    expect(sent).toEqual({ pin: ["@a/new"], unpin: [] });
    expect(ended.accepted).toBe(true);
    expect(store.pending()).toEqual(NO_SKILL_CHANGES);
    // Until the re-read the change still shows.
    expect(store.get().pin).toEqual(["@a/new"]);
    ended.settle(true);
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
  });

  it("keeps the changes of a turn refused or failed without an answer", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    turn(store, false).ended.settle(true);
    expect(store.pending().pin).toEqual(["@a/new"]);
    expect(store.get().pin).toEqual(["@a/new"]);
  });

  it("keeps a change made while the turn ran", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    store.take();
    toggle(store, stored([]), "@a/later");
    store.answered(true);
    store.end()!.settle(true);
    expect(store.pending().pin).toEqual(["@a/later"]);
  });

  it("keeps an entry the user re-recorded during the turn, even equal to what was sent", () => {
    const store = createSkillChanges();
    const server = stored([]);
    toggle(store, server, "@a/new");
    store.take();
    // Unchecked, then checked again while the turn ran: the same `pin` as sent, but the user's
    // latest act, not what the turn applied.
    toggle(store, server, "@a/new");
    toggle(store, server, "@a/new");
    expect(store.pending()).toEqual({ pin: ["@a/new"], unpin: [] });
    store.answered(true);
    store.end()!.settle(true);
    expect(store.pending()).toEqual({ pin: ["@a/new"], unpin: [] });
  });

  it("never resends an accepted turn's unpin from a turn queued between its end and the re-read", () => {
    const store = createSkillChanges();
    toggle(store, stored([assistantPin]), "@a/x");
    const { sent, ended } = turn(store, true);
    expect(sent).toEqual({ pin: [], unpin: ["@a/x"] });
    // The queue sends the next message at once, before the re-read lands.
    expect(store.take()).toBeUndefined();
    // The turn applied the unpin, then the assistant loaded the skill again: the re-read holds it.
    ended.settle(true);
    const after = conversationSkills(stored([assistantPin]), store.get());
    expect(skillRowState(after, "@a/x", new Set())).toEqual({
      kind: "loaded",
      source: "assistant",
    });
  });

  it("a queued turn sent before the previous one is ended leaves it to that turn's end", () => {
    const store = createSkillChanges();
    toggle(store, stored([assistantPin]), "@a/x");
    store.take();
    store.answered(true);
    // The queue's request leaves first; the accepted turn's unpin is not sent again.
    expect(store.take()).toBeUndefined();
    const ended = store.end()!;
    expect(ended.accepted).toBe(true);
    ended.settle(true);
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
  });

  it("keeps displaying what an accepted turn applied while the re-read fails", () => {
    const store = createSkillChanges();
    toggle(store, stored([]), "@a/new");
    const { ended } = turn(store, true);
    ended.settle(false);
    expect(store.pending()).toEqual(NO_SKILL_CHANGES);
    expect(store.get().pin).toEqual(["@a/new"]);
    // The next turn's re-read clears it.
    store.take();
    store.answered(true);
    store.end()!.settle(true);
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
  });

  it("re-checking during an in-flight unpin records the pin and shows it as next", () => {
    const store = createSkillChanges();
    const server = stored([assistantPin]);
    toggle(store, server, "@a/x");
    store.take();
    toggle(store, server, "@a/x");
    expect(store.pending()).toEqual({ pin: ["@a/x"], unpin: [] });
    expect(skillRowState(conversationSkills(server, store.get()), "@a/x", new Set())).toEqual({
      kind: "next",
    });
  });

  it("ends no turn when none was sent in this mount (a resumed one)", () => {
    expect(createSkillChanges().end()).toBeNull();
  });
});
