// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` directive parser, the mention loader and the projection. The
 * grammar is a fixed contract with the composer, and the projection lands in
 * the prompt-cache prefix, so exact block strings are pinned.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import type { ChatPlatformDeps } from "../src/platform-services.ts";
import {
  MAX_MENTIONED_SKILLS,
  MAX_SKILL_BODY_BYTES,
  SKILL_TRUNCATION_MARKER,
  TOO_MANY_SKILLS_REASON,
  loadMentionedSkills,
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
    // A 3-byte character (U+3042), so the cap — which is not a multiple of 3 —
    // lands MID-SEQUENCE and the decoder's replacement char has to be dropped.
    // A 2-byte character would divide the cap evenly and never exercise that.
    const body = "あ".repeat(MAX_SKILL_BODY_BYTES);
    const out = messagesWithSkillsAsText(
      [user("u1", directive("/a", "@acme/a"))],
      loadedMap({ package_id: "@acme/a", version: null, body }),
    );
    const text = (out[0]!.parts[0] as { text: string }).text;
    expect(text.endsWith(SKILL_TRUNCATION_MARKER)).toBe(true);
    // No U+FFFD: the half character the byte cut produced was removed, not
    // decoded into the prompt.
    expect(text).not.toContain("�");
    const injected = text.slice(
      "[Skill @acme/a loaded — follow these instructions]\n".length,
      -SKILL_TRUNCATION_MARKER.length,
    );
    expect(new TextEncoder().encode(injected).length).toBeLessThanOrEqual(MAX_SKILL_BODY_BYTES);
    expect(injected).toBe("あ".repeat(Math.floor(MAX_SKILL_BODY_BYTES / 3)));
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

const warnings: { msg: string; data?: Record<string, unknown> }[] = [];
const ARGS = {
  origin: "http://127.0.0.1:3000",
  headers: new Headers({ cookie: "session=abc", "x-space-id": "spc_1" }),
  log: { warn: (msg: string, data?: Record<string, unknown>) => warnings.push({ msg, data }) },
};

/** A dispatch scripted per request that records every call. */
function fakeDeps(respond: (req: Request) => Response | Promise<Response>): {
  deps: Pick<ChatPlatformDeps, "dispatch">;
  requests: Request[];
} {
  const requests: Request[] = [];
  return {
    deps: {
      dispatch: async (req) => {
        requests.push(req);
        return respond(req);
      },
    },
    requests,
  };
}

const problem = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

describe("loadMentionedSkills", () => {
  it("reads getSkill per id with the given headers, and maps content/version", async () => {
    const { deps, requests } = fakeDeps(() =>
      Response.json({ content: "# Copilot", version: "1.2.0" }),
    );

    const loaded = await loadMentionedSkills(deps, ARGS, ["@appstrate/copilot"]);

    expect(loaded.get("@appstrate/copilot")).toEqual({
      package_id: "@appstrate/copilot",
      version: "1.2.0",
      body: "# Copilot",
    });
    const url = new URL(requests[0]!.url);
    // Two path params: the `@` stays on the scope and the `/` stays a
    // separator — `encodeURIComponent` on the whole id would 404 here.
    expect(url.pathname).toBe("/api/packages/skills/@appstrate/copilot");
    expect(requests[0]!.headers.get("x-space-id")).toBe("spc_1");
    expect(requests[0]!.headers.get("cookie")).toBe("session=abc");
  });

  it("carries the problem's code for a refused or missing read", async () => {
    const { deps } = fakeDeps((req) =>
      new URL(req.url).pathname.endsWith("/gone")
        ? problem(404, { code: "package_not_found", title: "Not Found" })
        : problem(403, { title: "Forbidden" }),
    );

    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/gone", "@acme/secret"]);

    expect(loaded.get("@acme/gone")).toEqual({
      package_id: "@acme/gone",
      error: "package_not_found",
    });
    // No `code` in the body — the title is the next best thing to show.
    expect(loaded.get("@acme/secret")).toEqual({ package_id: "@acme/secret", error: "Forbidden" });
  });

  it("falls back to the status when the error body is not a problem document", async () => {
    const { deps } = fakeDeps(() => new Response("<html>oops</html>", { status: 502 }));
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect(loaded.get("@acme/a")).toEqual({ package_id: "@acme/a", error: "HTTP 502" });
  });

  it("reports a skill row with no content rather than injecting an empty block", async () => {
    const { deps } = fakeDeps(() => Response.json({ content: null, version: "1.0.0" }));
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect(loaded.get("@acme/a")).toEqual({
      package_id: "@acme/a",
      error: "the skill has no content",
    });
  });

  it("never throws: a thrown dispatch becomes a fixed reason, the error goes to the log", async () => {
    warnings.length = 0;
    const { deps } = fakeDeps(() => {
      throw new Error("socket hang up at 10.0.0.7");
    });
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect(loaded.get("@acme/a")).toEqual({
      package_id: "@acme/a",
      error: "the skill could not be read",
    });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.data?.err)).toContain("socket hang up at 10.0.0.7");
  });

  it("caps the conversation at MAX_MENTIONED_SKILLS and refuses the overflow", async () => {
    const { deps, requests } = fakeDeps(() => Response.json({ content: "x", version: null }));
    const ids = Array.from({ length: MAX_MENTIONED_SKILLS + 2 }, (_, i) => `@acme/s${i}`);

    const loaded = await loadMentionedSkills(deps, ARGS, ids);

    expect(requests).toHaveLength(MAX_MENTIONED_SKILLS);
    expect(loaded.size).toBe(ids.length);
    for (const id of ids.slice(MAX_MENTIONED_SKILLS)) {
      expect(loaded.get(id)).toEqual({ package_id: id, error: TOO_MANY_SKILLS_REASON });
    }
  });

  it("dedupes ids before spending a dispatch on them", async () => {
    const { deps, requests } = fakeDeps(() => Response.json({ content: "x", version: null }));
    await loadMentionedSkills(deps, ARGS, ["@acme/a", "@acme/a", "@acme/b"]);
    expect(requests).toHaveLength(2);
  });

  it("issues every read in parallel", async () => {
    let inFlight = 0;
    const gate = Promise.withResolvers<void>();
    const { deps } = fakeDeps(async () => {
      inFlight += 1;
      // Every dispatch is entered before any of them resolves — otherwise the
      // turn pays one round trip per mention on the TTFT path.
      if (inFlight === 3) gate.resolve();
      await gate.promise;
      return Response.json({ content: "x", version: null });
    });

    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a", "@acme/b", "@acme/c"]);

    expect(inFlight).toBe(3);
    expect(loaded.size).toBe(3);
  });
});
