// SPDX-License-Identifier: Apache-2.0

/** The skill picker's pure rules. */

import { describe, expect, it } from "bun:test";
import { MAX_PINNED_SKILLS, type ChatSkillChanges, type PinnedSkill } from "../src/skills.ts";
import {
  NO_SKILL_CHANGES,
  NO_SKILL_LAYERS,
  canResetSkills,
  changeDiscovery,
  changePin,
  citedSkillIds,
  conversationSkills,
  effectiveSkills,
  hasSkillChanges,
  loadsSkill,
  mergeSkillChanges,
  resetSkillChanges,
  withAppliedChanges,
  citeSkill,
  skillPickerRows,
  removesFromContext,
  skillRowState,
  type StoredSkills,
} from "../src/ui/chat-skills.ts";

const pin = (id: string, status: PinnedSkill["status"] = "injected"): PinnedSkill => ({
  id,
  status,
  chars: null,
});
const stored = (pins: PinnedSkill[] = [], skillDiscovery = true): StoredSkills => ({
  skillDiscovery,
  pins,
});
const changes = (c: Partial<ChatSkillChanges> = {}): ChatSkillChanges => ({
  ...NO_SKILL_CHANGES,
  ...c,
});

const local = (c: Partial<ChatSkillChanges>) => ({ ...NO_SKILL_LAYERS, local: changes(c) });

describe("conversationSkills", () => {
  it("applies the changes to the server's pins and discovery", () => {
    const skills = conversationSkills(
      stored([pin("@a/held"), pin("@a/dropped")], true),
      local({ pin: ["@a/new"], unpin: ["@a/dropped"], skillDiscovery: false }),
    );
    expect(skills.pinned).toEqual(["@a/held", "@a/new"]);
    expect(skills.skillDiscovery).toBe(false);
    expect(skills.stored.get("@a/held")).toEqual(pin("@a/held"));
  });

  it("is the server's state when nothing changed", () => {
    const skills = conversationSkills(stored([pin("@a/x")], false), NO_SKILL_LAYERS);
    expect(skills.pinned).toEqual(["@a/x"]);
    expect(skills.skillDiscovery).toBe(false);
  });

  it("layers the local changes over the in-flight ones, both pending until applied", () => {
    const skills = conversationSkills(stored([pin("@a/held")], true), {
      inFlight: changes({ pin: ["@a/sent"], skillDiscovery: false }),
      local: changes({ pin: ["@a/later"], unpin: ["@a/sent"] }),
    });
    expect(skills.pinned).toEqual(["@a/held", "@a/later"]);
    expect(skills.skillDiscovery).toBe(false);
    expect([...skills.pending].sort()).toEqual(["@a/later", "@a/sent"]);
  });
});

describe("mergeSkillChanges", () => {
  it("keeps both sides' changes, the newer winning where both decide", () => {
    expect(
      mergeSkillChanges(
        changes({ pin: ["@a/x", "@a/y"], unpin: ["@a/z"], skillDiscovery: false }),
        changes({ unpin: ["@a/x"], pin: ["@a/z"] }),
      ),
    ).toEqual(changes({ pin: ["@a/y", "@a/z"], unpin: ["@a/x"], skillDiscovery: false }));
    expect(
      mergeSkillChanges(changes({ skillDiscovery: false }), changes({ skillDiscovery: true })),
    ).toEqual(changes({ skillDiscovery: true }));
  });
});

describe("changePin", () => {
  const base = stored([pin("@a/held", "injected")]);

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

  it("records the undo of an in-flight change: made over the server's state with it applied", () => {
    const sentPin = withAppliedChanges(base, changes({ pin: ["@a/new"] }));
    expect(changePin(NO_SKILL_CHANGES, "@a/new", false, sentPin)).toEqual(
      changes({ unpin: ["@a/new"] }),
    );
    const sentUnpin = withAppliedChanges(base, changes({ unpin: ["@a/held"] }));
    expect(changePin(NO_SKILL_CHANGES, "@a/held", true, sentUnpin)).toEqual(
      changes({ pin: ["@a/held"] }),
    );
  });

  it("never sends a full set: the server's other pins are not named", () => {
    const many = stored([pin("@a/1"), pin("@a/2"), pin("@a/3")]);
    expect(changePin(NO_SKILL_CHANGES, "@a/2", false, many)).toEqual(changes({ unpin: ["@a/2"] }));
  });
});

describe("changeDiscovery", () => {
  const base = stored([], true);

  it("records a departure from the server and drops a return to it", () => {
    const off = changeDiscovery(NO_SKILL_CHANGES, false, base);
    expect(off).toEqual(changes({ skillDiscovery: false }));
    expect(changeDiscovery(off, true, base)).toEqual(NO_SKILL_CHANGES);
  });

  it("records a return to the server's value that undoes the turn in flight", () => {
    const sent = withAppliedChanges(base, changes({ skillDiscovery: false }));
    expect(changeDiscovery(NO_SKILL_CHANGES, true, sent)).toEqual(
      changes({ skillDiscovery: true }),
    );
  });
});

describe("resetSkillChanges", () => {
  it("unpins every pin and turns discovery back on", () => {
    const base = stored([pin("@a/held")], false);
    expect(resetSkillChanges(changes({ pin: ["@a/new"] }), ["@a/held", "@a/new"], base)).toEqual(
      changes({ skillDiscovery: true, unpin: ["@a/held"] }),
    );
  });
});

describe("withAppliedChanges", () => {
  it("applies the changes as the server does: unpins out, new pins unjudged, a re-pin kept as held", () => {
    const before = stored(
      [pin("@a/auto", "injected"), pin("@a/old"), pin("@a/kept", "over_budget")],
      true,
    );
    expect(
      withAppliedChanges(
        before,
        changes({ pin: ["@a/new", "@a/auto"], unpin: ["@a/old"], skillDiscovery: false }),
      ),
    ).toEqual(
      stored(
        [pin("@a/auto", "injected"), pin("@a/kept", "over_budget"), pin("@a/new", null)],
        false,
      ),
    );
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
      pin("@a/unseen", null),
      pin("@a/big", "over_budget"),
      pin("@a/gone", "unavailable"),
      pin("@a/broken", "unreadable"),
      pin("@a/dropped"),
    ]),
    local({ pin: ["@a/pending"], unpin: ["@a/dropped"] }),
  );
  const state = (id: string, cited: string[] = []) => skillRowState(skills, id, new Set(cited));

  it("reads each pin as the server reported it", () => {
    expect(state("@a/mine")).toEqual({ kind: "loaded" });
    expect(state("@a/unseen")).toEqual({ kind: "next" });
    expect(state("@a/big")).toEqual({ kind: "refused", reason: "over_budget" });
    expect(state("@a/gone")).toEqual({ kind: "refused", reason: "unavailable" });
    expect(state("@a/broken")).toEqual({ kind: "refused", reason: "unreadable" });
  });

  it("is next for a pending pin even over a stored verdict: the re-check postdates it", () => {
    const repinned = conversationSkills(
      stored([pin("@a/x", "injected")]),
      local({ pin: ["@a/x"] }),
    );
    expect(skillRowState(repinned, "@a/x", new Set())).toEqual({ kind: "next" });
  });

  it("is next for a pending pin, off for an unpinned one or a skill never pinned", () => {
    expect(state("@a/pending")).toEqual({ kind: "next" });
    expect(state("@a/other")).toEqual({ kind: "off" });
  });

  it("is unpin for a server pin unchecked since, and loads nothing", () => {
    expect(state("@a/dropped")).toEqual({ kind: "unpin" });
    expect(loadsSkill(state("@a/dropped"))).toBe(false);
    expect([...skills.unpinning]).toEqual(["@a/dropped"]);
  });

  it("is off again once a pending pin is unchecked: nothing was held", () => {
    const undone = conversationSkills(stored([]), local({ pin: [], unpin: ["@a/new"] }));
    expect(skillRowState(undone, "@a/new", new Set())).toEqual({ kind: "off" });
  });

  it("says unchecking removes a server pin from the context, not a pending or cited one", () => {
    const removes = (id: string, cited: string[] = []) =>
      removesFromContext(skills, id, state(id, cited));
    expect(removes("@a/mine")).toBe(true);
    expect(removes("@a/pending")).toBe(false);
    expect(removes("@a/mine", ["@a/mine"])).toBe(false);
    expect(removes("@a/dropped")).toBe(false);
  });

  it("is cited for a skill the draft cites, whatever the server says", () => {
    expect(state("@a/big", ["@a/big"])).toEqual({ kind: "cited" });
    expect(state("@a/other", ["@a/other"])).toEqual({ kind: "cited" });
  });

  it("never counts a refused pin as loaded", () => {
    expect(loadsSkill(state("@a/big"))).toBe(false);
    expect(loadsSkill(state("@a/other"))).toBe(false);
    expect(loadsSkill(state("@a/unseen"))).toBe(true);
    expect(loadsSkill(state("@a/x", ["@a/x"]))).toBe(true);
  });
});

describe("skillPickerRows", () => {
  const tone = { id: "@acme/tone", name: "Tone", description: "", version: "1.0.0", bytes: 120 };

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
        skill: { id: "@acme/gone", name: "gone", description: "", version: null, bytes: null },
        available: false,
      },
      {
        skill: { id: "@z/deleted", name: "deleted", description: "", version: null, bytes: null },
        available: false,
      },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      {
        skill: { id: "@acme/gone", name: "gone", description: "", version: null, bytes: null },
        available: false,
      },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});

const sk = (n: string) => `:skill[${n}]{name=@acme/${n}}`;

describe("citedSkillIds", () => {
  it("lists the skills a draft cites, once each, ignoring agents and plain text", () => {
    expect(citedSkillIds(`${sk("a")} x ${sk("b")} ${sk("a")} :agent[R]{name=run-r} /c`)).toEqual([
      "@acme/a",
      "@acme/b",
    ]);
    expect(citedSkillIds("nothing")).toEqual([]);
  });
});

describe("effectiveSkills", () => {
  it("is pinned then cited, a skill once, with the cited flag", () => {
    const e = effectiveSkills(["@acme/a", "@acme/b"], ["@acme/b", "@acme/c"]);
    expect(e.ids).toEqual(["@acme/a", "@acme/b", "@acme/c"]);
    expect([...e.cited]).toEqual(["@acme/b", "@acme/c"]);
  });

  it("counts the union against the cap", () => {
    const pinned = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@x/${i}`);
    expect(effectiveSkills(pinned, []).atCap).toBe(false);
    expect(effectiveSkills(pinned, ["@acme/a"]).atCap).toBe(true);
    expect(effectiveSkills(pinned, ["@acme/a"]).overCap).toBe(false);
    expect(effectiveSkills(pinned, ["@acme/a", "@acme/b"]).overCap).toBe(true);
    // Already pinned: no room taken.
    expect(effectiveSkills(pinned, ["@x/0"]).atCap).toBe(false);
  });
});

describe("canResetSkills", () => {
  const skills = (skillDiscovery: boolean, pinned: string[]) =>
    conversationSkills(
      { skillDiscovery, pins: pinned.map((id) => ({ id, status: "injected", chars: null })) },
      NO_SKILL_LAYERS,
    );
  const on = skills(true, ["@acme/a"]);

  it("is true for a pinned skill the draft does not cite, or with discovery off", () => {
    expect(canResetSkills(on, [])).toBe(true);
    expect(canResetSkills(on, ["@acme/b"])).toBe(true);
    expect(canResetSkills(skills(false, []), ["@acme/a"])).toBe(true);
  });

  it("is false when only cited skills are held: nothing visible would change", () => {
    expect(canResetSkills(on, ["@acme/a"])).toBe(false);
    expect(canResetSkills(skills(true, []), ["@acme/a"])).toBe(false);
  });
});
