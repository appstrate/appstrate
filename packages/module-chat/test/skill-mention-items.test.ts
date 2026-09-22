// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` mention contract, from both ends: assistant-ui's real directive
 * formatter into the server's real `parseSkillMentions`. A label equal to its
 * id (the formatter then omits `{name=…}`) or a syntax change fails here.
 */

import { describe, it, expect } from "bun:test";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import { parseSkillMentions } from "../src/skill-mentions.ts";
import { skillMentionItems } from "../src/ui/skill-directive.ts";
import { createSkillTriggerMatcher } from "../src/ui/skill-trigger.ts";
import type { SkillHint } from "../src/skills.ts";

function entry(packageId: string, over: Partial<SkillHint> = {}): SkillHint {
  return {
    package_id: packageId,
    display_name: packageId,
    description: `description of ${packageId}`,
    version: "1.0.0",
    ...over,
  };
}

describe("skillMentionItems", () => {
  it("labels a skill with a slash and its name part, keeping the id intact", () => {
    expect(skillMentionItems([entry("@appstrate/copilot")])).toEqual([
      {
        id: "@appstrate/copilot",
        type: "skill",
        label: "/copilot",
        description: "description of @appstrate/copilot",
      },
    ]);
  });

  it("omits the description of a skill that declares none", () => {
    expect(skillMentionItems([entry("@acme/bare", { description: null })])).toEqual([
      { id: "@acme/bare", type: "skill", label: "/bare" },
    ]);
  });

  it("never lets a label equal its id", () => {
    const items = skillMentionItems([
      entry("@appstrate/copilot"),
      entry("@acme/web-search"),
      entry("@appstrate/a"),
    ]);
    for (const item of items) expect(item.label).not.toBe(item.id);
  });

  it("keeps both skills that share a name part and disambiguates only those", () => {
    const items = skillMentionItems([
      entry("@appstrate/copilot"),
      entry("@acme/copilot"),
      entry("@appstrate/web-search"),
    ]);
    expect(items.map((i) => [i.id, i.label])).toEqual([
      ["@appstrate/copilot", "/copilot (@appstrate)"],
      ["@acme/copilot", "/copilot (@acme)"],
      ["@appstrate/web-search", "/web-search"],
    ]);
  });

  it("preserves the catalogue's order", () => {
    const ids = ["@z/one", "@a/two", "@m/three"];
    expect(skillMentionItems(ids.map((id) => entry(id))).map((i) => i.id)).toEqual(ids);
  });
});

describe("directive round-trip", () => {
  it("serialises a mention item to the exact string the server parses", () => {
    const [item] = skillMentionItems([entry("@appstrate/copilot")]);
    expect(unstable_defaultDirectiveFormatter.serialize(item!)).toBe(
      ":skill[/copilot]{name=@appstrate/copilot}",
    );
  });

  it("keeps the attribute on a disambiguated label too", () => {
    const items = skillMentionItems([entry("@appstrate/copilot"), entry("@acme/copilot")]);
    expect(items.map((i) => unstable_defaultDirectiveFormatter.serialize(i))).toEqual([
      ":skill[/copilot (@appstrate)]{name=@appstrate/copilot}",
      ":skill[/copilot (@acme)]{name=@acme/copilot}",
    ]);
  });

  it("is read back by the SERVER's parser, for every catalogue shape", () => {
    // The end-to-end contract: what the composer would insert is what the turn
    // resolver finds. Both a plain label and a disambiguated one, because the
    // disambiguated form is the one with spaces and parentheses in it.
    const items = skillMentionItems([
      entry("@appstrate/copilot"),
      entry("@acme/copilot"),
      entry("@appstrate/web-search"),
    ]);
    const text = `Résume ceci ${items.map((i) => unstable_defaultDirectiveFormatter.serialize(i)).join(" et ")} merci`;
    expect(parseSkillMentions(text).map((m) => [m.id, m.label])).toEqual([
      ["@appstrate/copilot", "/copilot (@appstrate)"],
      ["@acme/copilot", "/copilot (@acme)"],
      ["@appstrate/web-search", "/web-search"],
    ]);
  });
});

// An open trigger swallows Enter even with no rows: `/word` matching nothing must not open it.
describe("createSkillTriggerMatcher", () => {
  const items = skillMentionItems([entry("@appstrate/copilot"), entry("@acme/web-search")]);
  const matcher = createSkillTriggerMatcher(items);
  const at = (text: string) => matcher(text, "/", text.length);

  it("opens on a bare `/` so the popover can list everything", () => {
    expect(at("/")).toEqual({ query: "", offset: 0, endOffset: 1 });
    expect(at("regarde /")).toEqual({ query: "", offset: 8, endOffset: 9 });
  });

  it("opens while the query is still a prefix of a skill", () => {
    expect(at("/cop")).toEqual({ query: "cop", offset: 0, endOffset: 4 });
    expect(at("/COP")?.query).toBe("COP");
    expect(at("regarde /web")?.query).toBe("web");
  });

  it("opens on a substring, like the item filter the popover then runs", () => {
    // `/search` lists `/web-search`: a stricter matcher would hide those rows.
    expect(at("/search")?.query).toBe("search");
    expect(at("/SEARCH")?.query).toBe("SEARCH");
    expect(at("/pilot")?.query).toBe("pilot");
  });

  it("opens on a package id typed in full", () => {
    expect(at("/@appstrate")?.query).toBe("@appstrate");
  });

  it("stays closed on a word no skill contains", () => {
    expect(at("regarde /outputs")).toBeNull();
    expect(at("/zzz")).toBeNull();
  });

  it("stays closed on a `/` that does not start a word — a path, not a mention", () => {
    expect(at("src/copilot")).toBeNull();
  });

  it("never opens with an empty catalogue, not even on a bare `/`", () => {
    // A runner's 403 reads as `[]`: an open popover there would only swallow Enter.
    const empty = createSkillTriggerMatcher([]);
    expect(empty("/", "/", 1)).toBeNull();
    expect(empty("regarde /", "/", 9)).toBeNull();
    expect(empty("/cop", "/", 4)).toBeNull();
  });
});
