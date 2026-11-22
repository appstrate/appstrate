// SPDX-License-Identifier: Apache-2.0

/** The skill picker's pure rules. */

import { describe, expect, it } from "bun:test";
import type { ChatSkillChanges, PinnedSkill } from "../src/skills.ts";
import {
  NO_SKILL_CHANGES,
  changeDiscovery,
  changePin,
  conversationSkills,
  hasSkillChanges,
  loadsSkill,
  resetSkillChanges,
  subtractSkillChanges,
  citeSkill,
  skillPickerRows,
  skillRowState,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";

const pin = (
  id: string,
  status: PinnedSkill["status"] = "injected",
  source: PinnedSkill["source"] = "user",
): PinnedSkill => ({ id, source, status });
const stored = (pins: PinnedSkill[] = [], skillDiscovery = true): StoredSkills => ({
  skillDiscovery,
  pins,
});
const changes = (c: Partial<ChatSkillChanges> = {}): ChatSkillChanges => ({
  ...NO_SKILL_CHANGES,
  ...c,
});

describe("conversationSkills", () => {
  it("applies the changes to the server's pins and discovery", () => {
    const skills = conversationSkills(
      stored([pin("@a/held"), pin("@a/dropped")], true),
      changes({ pin: ["@a/new"], unpin: ["@a/dropped"], skillDiscovery: false }),
    );
    expect(skills.pinned).toEqual(["@a/held", "@a/new"]);
    expect(skills.skillDiscovery).toBe(false);
    expect(skills.stored.get("@a/held")).toEqual(pin("@a/held"));
  });

  it("is the server's state when nothing changed", () => {
    const skills = conversationSkills(stored([pin("@a/x")], false), NO_SKILL_CHANGES);
    expect(skills.pinned).toEqual(["@a/x"]);
    expect(skills.skillDiscovery).toBe(false);
  });
});

describe("changePin", () => {
  const base = { stored: stored([pin("@a/held", "injected", "assistant")]), inFlight: null };

  it("records a pin the server lacks and an unpin of one it holds", () => {
    expect(changePin(NO_SKILL_CHANGES, "@a/new", true, base)).toEqual(changes({ pin: ["@a/new"] }));
    expect(changePin(NO_SKILL_CHANGES, "@a/held", false, base)).toEqual(
      changes({ unpin: ["@a/held"] }),
    );
  });

  it("cancels a pending change instead of recording its opposite", () => {
    const pending = changes({ pin: ["@a/new"] });
    expect(changePin(pending, "@a/new", false, base)).toEqual(NO_SKILL_CHANGES);
    const unpinned = changes({ unpin: ["@a/held"] });
    // Re-checking an assistant's pin does not re-pin it as the user's.
    expect(changePin(unpinned, "@a/held", true, base)).toEqual(NO_SKILL_CHANGES);
  });

  it("records the undo of a change the turn in flight carries: the server is about to apply it", () => {
    const sentPin = { ...base, inFlight: changes({ pin: ["@a/new"] }) };
    expect(changePin(changes({ pin: ["@a/new"] }), "@a/new", false, sentPin)).toEqual(
      changes({ unpin: ["@a/new"] }),
    );
    const sentUnpin = { ...base, inFlight: changes({ unpin: ["@a/held"] }) };
    expect(changePin(changes({ unpin: ["@a/held"] }), "@a/held", true, sentUnpin)).toEqual(
      changes({ pin: ["@a/held"] }),
    );
  });

  it("never sends a full set: the server's other pins are not named", () => {
    const many = { stored: stored([pin("@a/1"), pin("@a/2"), pin("@a/3")]), inFlight: null };
    expect(changePin(NO_SKILL_CHANGES, "@a/2", false, many)).toEqual(changes({ unpin: ["@a/2"] }));
  });
});

describe("changeDiscovery", () => {
  const base = { stored: stored([], true), inFlight: null };

  it("records a departure from the server and drops a return to it", () => {
    const off = changeDiscovery(NO_SKILL_CHANGES, false, base);
    expect(off).toEqual(changes({ skillDiscovery: false }));
    expect(changeDiscovery(off, true, base)).toEqual(NO_SKILL_CHANGES);
  });

  it("keeps a return to the server's value that undoes the turn in flight", () => {
    const inFlight = { ...base, inFlight: changes({ skillDiscovery: false }) };
    expect(changeDiscovery(changes({ skillDiscovery: false }), true, inFlight)).toEqual(
      changes({ skillDiscovery: true }),
    );
  });
});

describe("resetSkillChanges", () => {
  it("unpins every pin and turns discovery back on", () => {
    const base = { stored: stored([pin("@a/held")], false), inFlight: null };
    expect(resetSkillChanges(changes({ pin: ["@a/new"] }), ["@a/held", "@a/new"], base)).toEqual(
      changes({ skillDiscovery: true, unpin: ["@a/held"] }),
    );
  });
});

describe("subtractSkillChanges", () => {
  it("drops every sent entry by value, whatever the server shows", () => {
    const sent = changes({ pin: ["@a/new"], unpin: ["@a/old"], skillDiscovery: false });
    expect(subtractSkillChanges(sent, sent)).toEqual(NO_SKILL_CHANGES);
  });

  it("keeps a change made during the turn, the undo of a sent one included", () => {
    const sent = changes({ pin: ["@a/new"], skillDiscovery: false });
    const now = changes({ pin: ["@a/later"], unpin: ["@a/new"], skillDiscovery: true });
    expect(subtractSkillChanges(now, sent)).toEqual(now);
  });
});

describe("citeSkill", () => {
  it("records the pin whatever the server holds, and cancels an unpin", () => {
    expect(citeSkill(NO_SKILL_CHANGES, "@a/held")).toEqual(changes({ pin: ["@a/held"] }));
    expect(citeSkill(changes({ unpin: ["@a/held"] }), "@a/held")).toEqual(
      changes({ pin: ["@a/held"] }),
    );
    expect(citeSkill(changes({ pin: ["@a/held"] }), "@a/held")).toEqual(
      changes({ pin: ["@a/held"] }),
    );
  });
});

describe("hasSkillChanges", () => {
  it("is false for no change, true for any field carrying one", () => {
    expect(hasSkillChanges(NO_SKILL_CHANGES)).toBe(false);
    expect(hasSkillChanges(changes({ skillDiscovery: true }))).toBe(true);
    expect(hasSkillChanges(changes({ unpin: ["@a/x"] }))).toBe(true);
  });
});

describe("skillRowState", () => {
  const skills = conversationSkills(
    stored([
      pin("@a/mine"),
      pin("@a/assistant", "injected", "assistant"),
      pin("@a/unseen", null),
      pin("@a/big", "over_budget"),
      pin("@a/gone", "unavailable", "assistant"),
      pin("@a/broken", "unreadable"),
      pin("@a/dropped"),
    ]),
    changes({ pin: ["@a/pending"], unpin: ["@a/dropped"] }),
  );
  const state = (id: string, cited: string[] = []) => skillRowState(skills, id, new Set(cited));

  it("reads each pin as the server reported it, with its source", () => {
    expect(state("@a/mine")).toEqual({ kind: "loaded", source: "user" });
    expect(state("@a/assistant")).toEqual({ kind: "loaded", source: "assistant" });
    expect(state("@a/unseen")).toEqual({ kind: "next" });
    expect(state("@a/big")).toEqual({ kind: "refused", reason: "over_budget" });
    expect(state("@a/gone")).toEqual({ kind: "refused", reason: "unavailable" });
    expect(state("@a/broken")).toEqual({ kind: "refused", reason: "unreadable" });
  });

  it("is next for a pending pin even over a stored verdict: the re-check postdates it", () => {
    const repinned = conversationSkills(stored([pin("@a/x", "injected", "assistant")]), {
      pin: ["@a/x"],
      unpin: [],
    });
    expect(skillRowState(repinned, "@a/x", new Set())).toEqual({ kind: "next" });
  });

  it("is next for a pending pin, off for an unpinned one or a skill never pinned", () => {
    expect(state("@a/pending")).toEqual({ kind: "next" });
    expect(state("@a/dropped")).toEqual({ kind: "off" });
    expect(state("@a/other")).toEqual({ kind: "off" });
  });

  it("is cited for a skill the draft cites, whatever the server says", () => {
    expect(state("@a/big", ["@a/big"])).toEqual({ kind: "cited" });
    expect(state("@a/other", ["@a/other"])).toEqual({ kind: "cited" });
  });

  it("never counts a refused pin as loaded", () => {
    expect(loadsSkill(state("@a/big"))).toBe(false);
    expect(loadsSkill(state("@a/other"))).toBe(false);
    expect(loadsSkill(state("@a/unseen"))).toBe(true);
    expect(loadsSkill(state("@a/assistant"))).toBe(true);
    expect(loadsSkill(state("@a/x", ["@a/x"]))).toBe(true);
  });
});

describe("skillPickerRows", () => {
  const tone = { id: "@acme/tone", name: "Tone", description: "", version: "1.0.0" };

  it("lists the catalogue as available rows, in its order", () => {
    const pdf = { ...tone, id: "@acme/pdf" };
    expect(skillPickerRows([tone, pdf], ["@acme/pdf"])).toEqual([
      { skill: tone, available: true },
      { skill: pdf, available: true },
    ]);
  });

  it("appends every pin the catalogue no longer lists, so it can be unpinned", () => {
    expect(skillPickerRows([tone], ["@acme/gone", "@acme/tone", "@z/deleted"])).toEqual([
      { skill: tone, available: true },
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null },
        available: false,
      },
      {
        skill: { id: "@z/deleted", name: "deleted", description: "", version: null },
        available: false,
      },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null },
        available: false,
      },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
