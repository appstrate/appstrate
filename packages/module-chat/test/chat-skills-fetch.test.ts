// SPDX-License-Identifier: Apache-2.0

/**
 * The two chat-skill requests, pinned against a scripted `fetch`.
 *
 * Both are hand-written against routes that live outside the typed client, so
 * nothing else checks the URL, the method, or the snake_case body the server
 * parses with Zod. A camelCase key here would type-check and 400 at runtime.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  chatSkillsQueryKey,
  fetchChatSkills,
  putSessionSkills,
  type ChatSkillEntry,
} from "../src/ui/chat-skills.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Capture {
  input: RequestInfo | URL;
  init?: RequestInit;
}

function scripted(response: () => Response): Capture {
  const capture = {} as Capture;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.input = input;
    capture.init = init;
    return response();
  }) as typeof fetch;
  return capture;
}

const entry = (over: Partial<ChatSkillEntry> = {}): ChatSkillEntry => ({
  package_id: "@appstrate/copilot",
  display_name: "Copilot",
  description: "Assemble un agent",
  version: "1.0.0",
  source: "platform",
  ...over,
});

describe("chatSkillsQueryKey", () => {
  it("scopes the catalogue to one space", () => {
    expect(chatSkillsQueryKey("spc_a")).toEqual(["chat", "skills", "spc_a"]);
    expect(chatSkillsQueryKey(null)).toEqual(["chat", "skills", null]);
  });
});

describe("fetchChatSkills", () => {
  it("GETs the catalogue with the host scoping headers and unwraps `skills`", async () => {
    const skills = [entry(), entry({ package_id: "@acme/tone", source: "space" })];
    const capture = scripted(
      () =>
        new Response(JSON.stringify({ skills }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const got = await fetchChatSkills(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

    expect(String(capture.input)).toBe("/api/chat/skills");
    expect(capture.init?.credentials).toBe("include");
    expect(capture.init?.headers).toEqual({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });
    expect(got).toEqual(skills);
  });

  it("treats a payload without `skills` as an empty catalogue", async () => {
    scripted(
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(await fetchChatSkills(() => ({}))).toEqual([]);
  });

  it("throws on a refused read", async () => {
    scripted(() => new Response(null, { status: 403 }));
    await expect(fetchChatSkills(() => ({}))).rejects.toThrow("HTTP 403");
  });
});

describe("putSessionSkills", () => {
  it("PUTs the snake_case body the route parses, with a normalized pin set", async () => {
    const capture = scripted(() => new Response(null, { status: 204 }));

    await putSessionSkills(() => ({ "X-Space-Id": "spc_a" }), "chs_1", {
      discovery: "manual",
      pinned: ["@scope/b", "@scope/a", "@scope/b"],
    });

    expect(String(capture.input)).toBe("/api/chat/sessions/chs_1/skills");
    expect(capture.init?.method).toBe("PUT");
    expect(capture.init?.credentials).toBe("include");
    expect(capture.init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Space-Id": "spc_a",
    });
    expect(JSON.parse(String(capture.init?.body))).toEqual({
      skill_discovery: "manual",
      pinned_skills: ["@scope/a", "@scope/b"],
    });
  });

  it("throws when the server refuses the write", async () => {
    scripted(() => new Response(null, { status: 400 }));
    await expect(
      putSessionSkills(() => ({}), "chs_1", { discovery: "auto", pinned: [] }),
    ).rejects.toThrow("HTTP 400");
  });
});
