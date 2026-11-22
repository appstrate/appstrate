// SPDX-License-Identifier: Apache-2.0

/**
 * The lifecycle of the user's skill changes (`createSkillChanges`, the store behind
 * `useConversationSkills`): taken by a turn; on a 2xx written into the server's state and out of
 * the layers; on a refusal kept for the next turn; on no answer at all dropped, never re-sent.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ChatSkillChanges, PinnedSkill } from "../src/skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  NO_SKILL_CHANGES,
  NO_SKILL_LAYERS,
  changePin,
  conversationSkills,
  skillRowState,
  withAppliedChanges,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";
import type { SessionHistory } from "../src/ui/sessions.ts";
import { createSkillChanges, writeAcceptedSkills } from "../src/ui/use-conversation-skills.ts";

const assistantPin: PinnedSkill = { id: "@a/x", source: "assistant", status: "injected" };

/** The store over a server state that accepted turns update, as the hook's cache write does. */
function conversation(stored: StoredSkills = DEFAULT_STORED_SKILLS) {
  const server = { stored };
  const accepted: ChatSkillChanges[] = [];
  let unanswered = 0;
  const store = createSkillChanges({
    accepted: (sent) => {
      accepted.push(sent);
      server.stored = withAppliedChanges(server.stored, sent);
    },
    unanswered: () => void unanswered++,
  });
  const skills = () => conversationSkills(server.stored, store.get());
  /** Toggles `id` from the panel, as the hook does. */
  const toggle = (id: string) =>
    store.change((local, inFlight) => {
      const base = withAppliedChanges(server.stored, inFlight);
      return changePin(local, id, !skills().pinned.includes(id), base);
    });
  const row = (id: string) => skillRowState(skills(), id, new Set());
  return { store, server, accepted, toggle, row, skills, unanswered: () => unanswered };
}

describe("skill changes across a turn", () => {
  it("a 2xx writes the sent changes into the server state and drops them", () => {
    const { store, server, toggle, row } = conversation();
    toggle("@a/new");
    expect(store.take()).toEqual({ pin: ["@a/new"], unpin: [] });
    store.answered("accepted");
    expect(store.get()).toEqual(NO_SKILL_LAYERS);
    expect(server.stored.pins).toEqual([{ id: "@a/new", source: "user", status: null }]);
    // Shown as loaded with the next message until the realtime read brings the verdict.
    expect(row("@a/new")).toEqual({ kind: "next" });
    expect(store.take()).toBeUndefined();
  });

  it("writes the cache before it drops the changes: no state shows them neither applied nor pending", () => {
    const seen: boolean[] = [];
    const server = { stored: DEFAULT_STORED_SKILLS };
    const store = createSkillChanges({
      accepted: (sent) => {
        server.stored = withAppliedChanges(server.stored, sent);
      },
      unanswered: () => {},
    });
    store.subscribe(() =>
      seen.push(conversationSkills(server.stored, store.get()).pinned.includes("@a/new")),
    );
    store.change((local) => ({ ...local, pin: ["@a/new"] }));
    store.take();
    store.answered("accepted");
    expect(seen).toEqual([true, true, true]);
  });

  it("an answered refusal keeps the changes for the next turn, written nowhere", () => {
    const { store, accepted, toggle, row } = conversation();
    toggle("@a/new");
    store.take();
    store.answered("refused");
    expect(accepted).toEqual([]);
    expect(store.get()).toEqual({ ...NO_SKILL_LAYERS, local: { pin: ["@a/new"], unpin: [] } });
    expect(row("@a/new")).toEqual({ kind: "next" });
    expect(store.take()).toEqual({ pin: ["@a/new"], unpin: [] });
  });

  it("a refusal keeps a change made while the turn was sent, the later one winning", () => {
    const { store, toggle } = conversation();
    toggle("@a/new");
    store.take();
    // Unchecked while the refused turn was in flight: the undo wins.
    toggle("@a/new");
    toggle("@a/other");
    store.answered("refused");
    expect(store.take()).toEqual({ pin: ["@a/other"], unpin: ["@a/new"] });
  });

  it("no answer at all drops the changes and never re-sends them", () => {
    const { store, accepted, toggle, row, unanswered } = conversation({
      skillDiscovery: true,
      pins: [assistantPin],
    });
    toggle("@a/x");
    expect(store.take()).toEqual({ pin: [], unpin: ["@a/x"] });
    store.answered("unanswered");
    expect(accepted).toEqual([]);
    expect(unanswered()).toBe(1);
    // The detail is the truth until it is read again: the server may or may not have unpinned it.
    expect(row("@a/x")).toEqual({ kind: "loaded", source: "assistant" });
    expect(store.take()).toBeUndefined();
  });

  it("keeps a change made while the turn ran for the next turn", () => {
    const { store, toggle } = conversation();
    toggle("@a/new");
    store.take();
    toggle("@a/later");
    store.answered("accepted");
    expect(store.get().local).toEqual({ pin: ["@a/later"], unpin: [] });
    expect(store.take()).toEqual({ pin: ["@a/later"], unpin: [] });
  });

  it("records the undo of an in-flight pin as an unpin, which survives the 2xx", () => {
    const { store, server, toggle, row } = conversation();
    toggle("@a/new");
    store.take();
    toggle("@a/new");
    expect(store.get().local).toEqual({ pin: [], unpin: ["@a/new"] });
    expect(row("@a/new")).toEqual({ kind: "off" });
    store.answered("accepted");
    expect(server.stored.pins.map((p) => p.id)).toEqual(["@a/new"]);
    expect(row("@a/new")).toEqual({ kind: "off" });
    expect(store.take()).toEqual({ pin: [], unpin: ["@a/new"] });
  });

  it("re-checking during an in-flight unpin records the pin and shows it as next", () => {
    const { store, toggle, row } = conversation({ skillDiscovery: true, pins: [assistantPin] });
    toggle("@a/x");
    store.take();
    toggle("@a/x");
    expect(store.get().local).toEqual({ pin: ["@a/x"], unpin: [] });
    expect(row("@a/x")).toEqual({ kind: "next" });
  });

  it("never resends an applied unpin when the assistant re-pins the skill in that turn", () => {
    const { store, server, toggle, row } = conversation({
      skillDiscovery: true,
      pins: [assistantPin],
    });
    toggle("@a/x");
    store.take();
    store.answered("accepted");
    // The assistant loaded the skill again in that turn: the realtime read brings it back.
    server.stored = { skillDiscovery: true, pins: [assistantPin] };
    // The queue sends the next message: nothing of the first turn rides with it.
    expect(store.take()).toBeUndefined();
    expect(row("@a/x")).toEqual({ kind: "loaded", source: "assistant" });
  });

  it("a queued turn sent while the previous one still streams takes only its own changes", () => {
    const { store, toggle, accepted } = conversation();
    toggle("@a/a");
    store.take();
    store.answered("accepted");
    toggle("@a/b");
    // The first turn is still streaming: the queue's request leaves.
    expect(store.take()).toEqual({ pin: ["@a/b"], unpin: [] });
    store.answered("accepted");
    expect(accepted).toEqual([
      { pin: ["@a/a"], unpin: [] },
      { pin: ["@a/b"], unpin: [] },
    ]);
    expect(store.get()).toEqual(NO_SKILL_LAYERS);
  });

  it("tells an accepted turn without any change, so a new conversation is read from then on", () => {
    const { store, accepted } = conversation();
    expect(store.take()).toBeUndefined();
    store.answered("accepted");
    expect(accepted).toEqual([NO_SKILL_CHANGES]);
  });
});

describe("writeAcceptedSkills", () => {
  const KEY = ["get", "/api/orgs/{orgId}/chat/sessions/{id}", { params: { path: { id: "c" } } }];
  const detail = (pins: PinnedSkill[]) =>
    ({
      id: "c",
      messages: [],
      skills: { skillDiscovery: true, pins },
    }) as unknown as SessionHistory;
  const sent: ChatSkillChanges = { pin: ["@a/new"], unpin: [] };

  it("writes the sent changes into the cached detail", () => {
    const qc = new QueryClient();
    qc.setQueryData(KEY, detail([assistantPin]));
    expect(writeAcceptedSkills(qc, KEY, sent)).toBe(true);
    expect(qc.getQueryData<SessionHistory>(KEY)!.skills.pins.map((p) => p.id)).toEqual([
      "@a/new",
      "@a/x",
    ]);
  });

  it("writes nothing when no detail is cached: the caller keeps them aside", () => {
    const qc = new QueryClient();
    expect(writeAcceptedSkills(qc, KEY, sent)).toBe(false);
    expect(qc.getQueryData(KEY)).toBeUndefined();
  });

  /**
   * The detail as the host's realtime keeps it: observed (so an invalidation refetches), each read
   * answering the server's state when it started, held until `flush`.
   */
  function observedDetail(initial: SessionHistory) {
    const qc = new QueryClient();
    qc.setQueryData(KEY, initial);
    const server = { row: initial };
    const held: (() => void)[] = [];
    const observer = new QueryObserver(qc, {
      queryKey: KEY,
      queryFn: () => {
        const answer = server.row;
        return new Promise<SessionHistory>((resolve) => held.push(() => resolve(answer)));
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const flush = async () => {
      while (held.length > 0) {
        held.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const pins = () => qc.getQueryData<SessionHistory>(KEY)!.skills.pins;
    return { qc, server, observer, flush, pins, unsubscribe };
  }

  it("a read started before the claim cannot land over the write: the detail is read again", async () => {
    const { qc, server, observer, flush, pins, unsubscribe } = observedDetail(detail([]));
    void observer.refetch();
    // The claim applies the change, then the turn answers 2xx.
    server.row = detail([{ id: "@a/new", source: "user", status: "injected" }]);
    writeAcceptedSkills(qc, KEY, sent);
    await flush();
    expect(pins()).toEqual([{ id: "@a/new", source: "user", status: "injected" }]);
    unsubscribe();
  });

  it("the verdict of a read started after the claim wins over the write", async () => {
    const { qc, server, observer, flush, pins, unsubscribe } = observedDetail(detail([]));
    // The claim's signal makes the realtime read the detail, which already holds the verdict.
    server.row = detail([{ id: "@a/new", source: "user", status: "over_budget" }]);
    void observer.refetch();
    writeAcceptedSkills(qc, KEY, sent);
    // Until the read lands, the write shows the pin as not judged yet.
    expect(pins()).toEqual([{ id: "@a/new", source: "user", status: null }]);
    await flush();
    expect(pins()).toEqual([{ id: "@a/new", source: "user", status: "over_budget" }]);
    expect(qc.getQueryState(KEY)!.isInvalidated).toBe(false);
    unsubscribe();
  });
});
