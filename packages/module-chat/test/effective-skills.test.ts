// SPDX-License-Identifier: Apache-2.0

/** The skills a conversation will load: pinned plus cited in the draft, the one place the cap is counted. */

import { describe, expect, it } from "bun:test";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";
import {
  canResetSkills,
  citedSkillIds,
  conversationSkills,
  effectiveSkills,
  NO_SKILL_LAYERS,
} from "../src/ui/chat-skills.ts";
import { draftIssue } from "../src/ui/directive-send.ts";
import { commandList } from "../src/ui/composer-commands.ts";

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

  it("is what the send refusal and the / menu both read", () => {
    const pinned = ["@x/0", "@x/1", "@x/2", "@x/3"];
    expect(draftIssue(`${sk("a")} ${sk("b")}`, pinned)).toBe("pins");
    const commands = {
      skills: [{ id: "@acme/z", name: "z", description: "", version: null }],
      agents: [],
    };
    const list = commandList(commands, { pinned, running: false, draft: sk("a") });
    expect(list.capped.map((i) => i.id)).toEqual(["@acme/z"]);
  });
});

describe("canResetSkills", () => {
  const skills = (skillDiscovery: boolean, pinned: string[]) =>
    conversationSkills(
      { skillDiscovery, pins: pinned.map((id) => ({ id, source: "user", status: "injected" })) },
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
