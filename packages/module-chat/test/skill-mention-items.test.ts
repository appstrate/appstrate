// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` mention contract, from both ends.
 *
 * The composer popover and the server's turn resolver never call each other:
 * they agree only on ONE string shape, `:skill[/name]{name=@scope/name}`,
 * WRITTEN by assistant-ui's default directive formatter and READ by
 * `parseSkillMentions` (`src/skill-mentions.ts`). This file is the one place
 * the two halves meet, so it runs the real formatter into the real parser.
 *
 * Two things can silently break the agreement — a label that happens to equal
 * the id (the formatter then OMITS `{name=…}` and the package id is lost), and
 * a library change to the syntax itself. Either one turns every mention into
 * prose in a running conversation with no error anywhere; both fail here.
 */

import { describe, it, expect } from "bun:test";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import { parseSkillMentions } from "../src/skill-mentions.ts";
import { skillMentionItems } from "../src/ui/skill-directive.ts";
import type { ChatSkillEntry } from "../src/ui/chat-skills.ts";

function entry(packageId: string, over: Partial<ChatSkillEntry> = {}): ChatSkillEntry {
  return {
    package_id: packageId,
    display_name: packageId,
    description: `description of ${packageId}`,
    version: "1.0.0",
    source: "space",
    ...over,
  };
}

describe("skillMentionItems", () => {
  it("labels a skill with a slash and its name part, keeping the id intact", () => {
    expect(skillMentionItems([entry("@appstrate/copilot", { source: "platform" })])).toEqual([
      {
        id: "@appstrate/copilot",
        type: "skill",
        label: "/copilot",
        description: "description of @appstrate/copilot",
        metadata: { source: "platform" },
      },
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

  it("carries the source through so the popover can flag platform skills", () => {
    const items = skillMentionItems([
      entry("@appstrate/copilot", { source: "platform" }),
      entry("@acme/notes", { source: "space" }),
    ]);
    expect(items.map((i) => i.metadata)).toEqual([{ source: "platform" }, { source: "space" }]);
  });

  it("preserves the catalogue's order", () => {
    const ids = ["@z/one", "@a/two", "@m/three"];
    expect(skillMentionItems(ids.map((id) => entry(id))).map((i) => i.id)).toEqual(ids);
  });
});

describe("directive round-trip", () => {
  it("serialises a mention item to the exact string the server parses", () => {
    const [item] = skillMentionItems([entry("@appstrate/copilot", { source: "platform" })]);
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
