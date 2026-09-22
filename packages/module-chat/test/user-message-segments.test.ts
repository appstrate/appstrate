// SPDX-License-Identifier: Apache-2.0

/**
 * What a sent user bubble shows.
 *
 * The persisted message text is the audit trail — the server re-resolves the
 * mention from it on every turn — so the bubble may only change how that text
 * is PRESENTED. This splitter is the whole of that change, and the properties
 * that matter are negative ones: nothing is dropped, and nothing the server
 * will read as prose is shown as a chip. The second one holds by construction
 * (the splitter runs the SERVER's `parseSkillMentions`); the cases below are
 * what proves the first, and that the two never disagree in practice.
 */

import { describe, it, expect } from "bun:test";
import { splitSkillDirectives } from "../src/skill-mentions.ts";

describe("splitSkillDirectives", () => {
  it("returns plain text as a single run", () => {
    expect(splitSkillDirectives("Bonjour, peux-tu m'aider ?")).toEqual([
      { kind: "text", text: "Bonjour, peux-tu m'aider ?" },
    ]);
  });

  it("returns nothing for an empty text", () => {
    expect(splitSkillDirectives("")).toEqual([]);
  });

  it("splits a directive out of the surrounding prose", () => {
    expect(
      splitSkillDirectives("Avec :skill[/copilot]{name=@appstrate/copilot} crée un agent"),
    ).toEqual([
      { kind: "text", text: "Avec " },
      { kind: "skill", label: "/copilot", id: "@appstrate/copilot" },
      { kind: "text", text: " crée un agent" },
    ]);
  });

  it("handles several mentions in one message", () => {
    expect(
      splitSkillDirectives(
        ":skill[/copilot]{name=@appstrate/copilot} puis :skill[/web-search]{name=@appstrate/web-search}",
      ),
    ).toEqual([
      { kind: "skill", label: "/copilot", id: "@appstrate/copilot" },
      { kind: "text", text: " puis " },
      { kind: "skill", label: "/web-search", id: "@appstrate/web-search" },
    ]);
  });

  it("keeps newlines in the prose runs (the bubble is pre-wrap)", () => {
    expect(splitSkillDirectives("un\n\ndeux")).toEqual([{ kind: "text", text: "un\n\ndeux" }]);
  });

  it("renders a directive of another type as the raw text it is", () => {
    expect(splitSkillDirectives("a :tool[search]{name=web_search} b")).toEqual([
      { kind: "text", text: "a :tool[search]{name=web_search} b" },
    ]);
  });

  it("renders a skill directive with a malformed id as raw text", () => {
    // The server's parser requires a canonical `@scope/name`; anything else
    // stays prose there, hence here.
    expect(splitSkillDirectives("x :skill[/oops]{name=not-a-package} y")).toEqual([
      { kind: "text", text: "x :skill[/oops]{name=not-a-package} y" },
    ]);
  });

  it("renders an attribute-less directive as raw text", () => {
    // The server's parser requires the `{name=…}` attribute outright: the
    // formatter omits it only when label === id, which a `/`-prefixed label
    // can never be.
    expect(splitSkillDirectives("voir :skill[/copilot] ici")).toEqual([
      { kind: "text", text: "voir :skill[/copilot] ici" },
    ]);
  });

  it("loses no character of the original text", () => {
    const text = "a :skill[/copilot]{name=@appstrate/copilot} b :tool[t] c";
    const rebuilt = splitSkillDirectives(text)
      .map((s) => (s.kind === "text" ? s.text : `:skill[${s.label}]{name=${s.id}}`))
      .join("");
    expect(rebuilt).toBe(text);
  });
});
