// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` directive parser and the projection that turns a mention into
 * the text the model reads.
 *
 * The directive grammar is a FIXED CONTRACT with the composer (assistant-ui's
 * `unstable_defaultDirectiveFormatter`), and the projection lands inside the
 * prompt-cache prefix — so both the exact block strings and the determinism of
 * the projection are pinned here rather than left to the reader.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  MAX_SKILL_BODY_BYTES,
  SKILL_TRUNCATION_MARKER,
  mentionedSkillIds,
  messagesWithSkillsAsText,
  parseSkillMentions,
  type LoadedSkill,
} from "../src/skill-mentions.ts";

/** What the composer inserts for one mention. */
const directive = (label: string, id: string) => `:skill[${label}]{name=${id}}`;

const user = (id: string, ...texts: string[]): UIMessage => ({
  id,
  role: "user",
  parts: texts.map((text) => ({ type: "text" as const, text })),
});

const loadedMap = (...skills: LoadedSkill[]): ReadonlyMap<string, LoadedSkill> =>
  new Map(skills.map((skill) => [skill.package_id, skill]));

describe("parseSkillMentions", () => {
  it("parses the formatter's directive into id, label, raw text and offset", () => {
    const text = `Hello ${directive("/copilot", "@appstrate/copilot")} world`;
    expect(parseSkillMentions(text)).toEqual([
      {
        id: "@appstrate/copilot",
        label: "/copilot",
        raw: ":skill[/copilot]{name=@appstrate/copilot}",
        index: 6,
      },
    ]);
  });

  it("ignores a directive of any other type", () => {
    // Only `skill` is ours; every other directive the formatter can emit is
    // prose as far as this server is concerned.
    expect(parseSkillMentions(":agent[/copilot]{name=@appstrate/copilot}")).toEqual([]);
    expect(parseSkillMentions(":skills[/x]{name=@a/b}")).toEqual([]);
  });

  it("ignores a name that is not a canonical scoped id", () => {
    // Validated against `scopedNameRegex`, which the loose finder regex is
    // deliberately wider than: leading/trailing dashes, no scope, wrong case.
    expect(parseSkillMentions(":skill[/x]{name=@-acme/tone}")).toEqual([]);
    expect(parseSkillMentions(":skill[/x]{name=@acme/tone-}")).toEqual([]);
    expect(parseSkillMentions(":skill[/x]{name=acme/tone}")).toEqual([]);
    expect(parseSkillMentions(":skill[/x]{name=@Acme/Tone}")).toEqual([]);
  });

  it("parses several mentions in one part, in source order", () => {
    const text = `${directive("/a", "@acme/a")} then ${directive("/b", "@acme/b")}`;
    expect(parseSkillMentions(text).map((m) => m.id)).toEqual(["@acme/a", "@acme/b"]);
  });

  it("leaves prose that merely contains `:skill[` alone", () => {
    const prose =
      "Écris `:skill[` dans un message et rien ne doit se passer — même :skill[x] seul.";
    expect(parseSkillMentions(prose)).toEqual([]);
  });

  it("is free of regex lastIndex state across calls", () => {
    const text = directive("/a", "@acme/a");
    expect(parseSkillMentions(text)).toEqual(parseSkillMentions(text));
  });
});

describe("mentionedSkillIds", () => {
  it("unions every user message, in first-appearance order, deduped", () => {
    const messages: UIMessage[] = [
      user("u1", `${directive("/b", "@acme/b")} et ${directive("/a", "@acme/a")}`),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: directive("/z", "@acme/z") }] },
      user("u2", directive("/a", "@acme/a"), directive("/c", "@acme/c")),
    ];
    // `@acme/z` is the assistant's own text — never a mention.
    expect(mentionedSkillIds(messages)).toEqual(["@acme/b", "@acme/a", "@acme/c"]);
  });

  it("is empty for a branch with no directive", () => {
    expect(mentionedSkillIds([user("u1", "bonjour")])).toEqual([]);
  });
});

describe("messagesWithSkillsAsText", () => {
  it("injects the body on first occurrence and a back-reference afterwards", () => {
    const messages: UIMessage[] = [
      user("u1", `Suis ${directive("/copilot", "@appstrate/copilot")} stp`),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
      user("u2", `Encore ${directive("/copilot", "@appstrate/copilot")}`),
    ];
    const out = messagesWithSkillsAsText(
      messages,
      loadedMap({ package_id: "@appstrate/copilot", version: "1.2.0", body: "# Copilot\nfais X" }),
    );

    expect((out[0]!.parts[0] as { text: string }).text).toBe(
      "Suis [Skill @appstrate/copilot (v1.2.0) loaded — follow these instructions]\n# Copilot\nfais X stp",
    );
    expect((out[2]!.parts[0] as { text: string }).text).toBe(
      "Encore [Skill @appstrate/copilot already loaded above]",
    );
  });

  it("omits the version when the definition read declares none", () => {
    const out = messagesWithSkillsAsText(
      [user("u1", directive("/a", "@acme/a"))],
      loadedMap({ package_id: "@acme/a", version: null, body: "corps" }),
    );
    expect((out[0]!.parts[0] as { text: string }).text).toBe(
      "[Skill @acme/a loaded — follow these instructions]\ncorps",
    );
  });

  it("renders the loader's reason for a skill it could not read", () => {
    const out = messagesWithSkillsAsText(
      [user("u1", directive("/a", "@acme/a"))],
      loadedMap({ package_id: "@acme/a", error: "package_not_found" }),
    );
    expect((out[0]!.parts[0] as { text: string }).text).toBe(
      "[Skill @acme/a could not be loaded: package_not_found]",
    );
  });

  it("renders an id the map never mentions as unresolved rather than as prose", () => {
    const out = messagesWithSkillsAsText([user("u1", directive("/a", "@acme/a"))], new Map());
    expect((out[0]!.parts[0] as { text: string }).text).toBe(
      "[Skill @acme/a could not be loaded: not resolved for this turn]",
    );
  });

  it("caps an oversized body on a character boundary and marks the cut", () => {
    // A 3-byte character repeated past the cap, so a naive byte slice would
    // split one in half.
    const body = "é".repeat(MAX_SKILL_BODY_BYTES);
    const out = messagesWithSkillsAsText(
      [user("u1", directive("/a", "@acme/a"))],
      loadedMap({ package_id: "@acme/a", version: null, body }),
    );
    const text = (out[0]!.parts[0] as { text: string }).text;
    expect(text.endsWith(SKILL_TRUNCATION_MARKER)).toBe(true);
    expect(text).not.toContain("�");
    const injected = text.slice(
      "[Skill @acme/a loaded — follow these instructions]\n".length,
      -SKILL_TRUNCATION_MARKER.length,
    );
    expect(new TextEncoder().encode(injected).length).toBeLessThanOrEqual(MAX_SKILL_BODY_BYTES);
    expect(injected).toBe("é".repeat(MAX_SKILL_BODY_BYTES / 2));
  });

  it("leaves a body under the cap untouched", () => {
    const out = messagesWithSkillsAsText(
      [user("u1", directive("/a", "@acme/a"))],
      loadedMap({ package_id: "@acme/a", version: null, body: "court" }),
    );
    expect((out[0]!.parts[0] as { text: string }).text).not.toContain(SKILL_TRUNCATION_MARKER);
  });

  it("is deterministic — the projection sits inside the prompt-cache prefix", () => {
    const messages: UIMessage[] = [
      user("u1", directive("/a", "@acme/a")),
      user("u2", `${directive("/a", "@acme/a")} ${directive("/b", "@acme/b")}`),
    ];
    const loaded = loadedMap(
      { package_id: "@acme/a", version: "1.0.0", body: "A" },
      { package_id: "@acme/b", error: "skills_read_forbidden" },
    );
    expect(messagesWithSkillsAsText(messages, loaded)).toEqual(
      messagesWithSkillsAsText(messages, loaded),
    );
  });

  it("never rewrites a non-user message", () => {
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: directive("/a", "@acme/a") }],
    };
    const out = messagesWithSkillsAsText(
      [assistant],
      loadedMap({ package_id: "@acme/a", version: null, body: "corps" }),
    );
    // Same object: a message with nothing to rewrite is not even copied.
    expect(out[0]).toBe(assistant);
  });

  it("never touches a non-text part of a message it does rewrite", () => {
    const file = { type: "file" as const, url: "appfile://file_1", mediaType: "text/plain" };
    const message: UIMessage = {
      id: "u1",
      role: "user",
      parts: [file, { type: "text", text: directive("/a", "@acme/a") }],
    };
    const out = messagesWithSkillsAsText(
      [message],
      loadedMap({ package_id: "@acme/a", version: null, body: "corps" }),
    );
    expect(out[0]!.parts[0]).toBe(file);
    expect((out[0]!.parts[1] as { text: string }).text).toContain("loaded — follow these");
  });

  it("returns a message with no directive unchanged", () => {
    const message = user("u1", "aucune mention ici");
    expect(messagesWithSkillsAsText([message], new Map())[0]).toBe(message);
  });
});
