// SPDX-License-Identifier: Apache-2.0

/**
 * The lifecycle of the user's skill changes (`createSkillChanges`, the state machine behind
 * `useConversationSkills`): taken by a turn; applied to the server's state and out of the next
 * send as soon as the server accepts the turn; kept when it refuses it; a change made while the
 * turn ran always kept.
 */

import { describe, expect, it } from "bun:test";
import type { ChatSkillChanges, PinnedSkill } from "../src/skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  NO_SKILL_CHANGES,
  changePin,
  conversationSkills,
  skillRowState,
  withAppliedChanges,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";
import { createSkillChanges } from "../src/ui/use-conversation-skills.ts";

const assistantPin: PinnedSkill = { id: "@a/x", source: "assistant", status: "injected" };

/** The store over a server state that accepted turns update, as the hook's cache write does. */
function conversation(pins: PinnedSkill[] = []) {
  const server: { stored: StoredSkills } = { stored: { skillDiscovery: true, pins } };
  const accepted: ChatSkillChanges[] = [];
  const store = createSkillChanges((sent) => {
    accepted.push(sent);
    server.stored = withAppliedChanges(server.stored, sent);
  });
  /** Toggles `id` from the panel, as the hook does. */
  const toggle = (id: string) =>
    store.change((current, inFlight) =>
      changePin(current, id, !conversationSkills(server.stored, current).pinned.includes(id), {
        stored: server.stored,
        inFlight,
      }),
    );
  const row = (id: string) =>
    skillRowState(conversationSkills(server.stored, store.get()), id, new Set());
  return { store, server, accepted, toggle, row };
}

describe("skill changes across a turn", () => {
  it("an accepted turn's changes reach the server's state and leave the next send", () => {
    const { store, server, toggle, row } = conversation();
    toggle("@a/new");
    expect(store.take()).toEqual({ pin: ["@a/new"], unpin: [] });
    store.answered(true);
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
    expect(server.stored.pins).toEqual([{ id: "@a/new", source: "user", status: null }]);
    // Shown as loaded with the next message until a read brings the turn's verdict.
    expect(row("@a/new")).toEqual({ kind: "next" });
    expect(store.end()).toBe(true);
    expect(store.take()).toBeUndefined();
  });

  it("keeps the changes of a turn refused or failed without an answer", () => {
    const { store, accepted, toggle } = conversation();
    toggle("@a/new");
    store.take();
    store.answered(false);
    store.end();
    expect(store.get().pin).toEqual(["@a/new"]);
    expect(accepted).toEqual([]);
  });

  it("keeps a change made while the turn ran", () => {
    const { store, toggle } = conversation();
    toggle("@a/new");
    store.take();
    toggle("@a/later");
    store.answered(true);
    expect(store.get()).toEqual({ pin: ["@a/later"], unpin: [] });
  });

  it("keeps an entry the user re-recorded during the turn, even equal to what was sent", () => {
    const { store, toggle } = conversation();
    toggle("@a/new");
    store.take();
    // Unchecked, then checked again while the turn ran: the same `pin` as sent, but a later act.
    toggle("@a/new");
    toggle("@a/new");
    expect(store.get()).toEqual({ pin: ["@a/new"], unpin: [] });
    store.answered(true);
    expect(store.get()).toEqual({ pin: ["@a/new"], unpin: [] });
  });

  it("never resends an applied unpin when the assistant re-pins the skill in that turn", () => {
    const { store, server, toggle, row } = conversation([assistantPin]);
    toggle("@a/x");
    expect(store.take()).toEqual({ pin: [], unpin: ["@a/x"] });
    store.answered(true);
    // The queue sends the next message at once, before the turn's end is even seen.
    expect(store.take()).toBeUndefined();
    store.answered(true);
    // The assistant loaded the skill again in that turn: the read brings it back.
    server.stored = { skillDiscovery: true, pins: [assistantPin] };
    expect(store.end()).toBe(true);
    expect(store.take()).toBeUndefined();
    expect(row("@a/x")).toEqual({ kind: "loaded", source: "assistant" });
  });

  it("leaves a queued turn sent before the previous one ended open, to take its own answer", () => {
    const { store, toggle } = conversation();
    toggle("@a/a");
    store.take();
    store.answered(true);
    toggle("@a/b");
    // The queue's request leaves before the first turn's end.
    expect(store.take()).toEqual({ pin: ["@a/b"], unpin: [] });
    expect(store.end()).toBe(true);
    // Its answer still lands on it.
    store.answered(true);
    expect(store.get()).toEqual(NO_SKILL_CHANGES);
  });

  it("re-checking during an in-flight unpin records the pin and shows it as next", () => {
    const { store, toggle, row } = conversation([assistantPin]);
    toggle("@a/x");
    store.take();
    toggle("@a/x");
    expect(store.get()).toEqual({ pin: ["@a/x"], unpin: [] });
    expect(row("@a/x")).toEqual({ kind: "next" });
  });

  it("a new conversation shows its pins after its first turn, before any read", () => {
    const { store, server, accepted, toggle, row } = conversation();
    expect(server.stored).toEqual(DEFAULT_STORED_SKILLS);
    toggle("@a/new");
    store.take();
    store.answered(true);
    expect(accepted).toHaveLength(1);
    expect(row("@a/new")).toEqual({ kind: "next" });
  });

  it("tells an accepted turn without any change, so a new conversation is read from then on", () => {
    const { store, accepted } = conversation();
    expect(store.take()).toBeUndefined();
    store.answered(true);
    expect(accepted).toEqual([NO_SKILL_CHANGES]);
  });

  it("ends no turn when none was sent in this mount (a resumed one)", () => {
    expect(conversation().store.end()).toBe(false);
  });
});
