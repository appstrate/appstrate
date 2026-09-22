// SPDX-License-Identifier: Apache-2.0

/**
 * The two chat-skill requests, pinned against a scripted `fetch`: nothing
 * else checks their URL, method, or the snake_case body the server parses.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chatSkillsQueryKey, fetchChatSkills, putSessionSkills } from "../src/ui/chat-skills.ts";

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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("chatSkillsQueryKey", () => {
  it("scopes the catalogue to one space", () => {
    expect(chatSkillsQueryKey("spc_a")).toEqual(["chat", "skills", "spc_a"]);
    expect(chatSkillsQueryKey(null)).toEqual(["chat", "skills", null]);
  });
});

describe("fetchChatSkills", () => {
  it("GETs the space listing with the scoping headers and projects each row", async () => {
    const capture = scripted(() =>
      json({
        object: "list",
        hasMore: false,
        data: [
          {
            id: "@acme/tone",
            name: "Tone",
            description: "Adjusts tone",
            version: "1.2.0",
            icon: null,
            keywords: [],
            source: "local",
          },
          { id: "@acme/bare", name: "@acme/bare", description: null, version: null },
        ],
      }),
    );

    const got = await fetchChatSkills(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

    expect(String(capture.input)).toBe("/api/packages/skills");
    expect(capture.init?.credentials).toBe("include");
    expect(capture.init?.headers).toEqual({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });
    expect(got).toEqual([
      {
        package_id: "@acme/tone",
        display_name: "Tone",
        description: "Adjusts tone",
        version: "1.2.0",
      },
      { package_id: "@acme/bare", display_name: "@acme/bare", description: null, version: null },
    ]);
  });

  it("reads a 403 (no `skills:read`) as nothing to offer", async () => {
    scripted(() => new Response(null, { status: 403 }));
    expect(await fetchChatSkills(() => ({}))).toEqual([]);
  });

  it("throws on any other refusal", async () => {
    scripted(() => new Response(null, { status: 500 }));
    await expect(fetchChatSkills(() => ({}))).rejects.toThrow("HTTP 500");
  });
});

describe("putSessionSkills", () => {
  it("PUTs the snake_case body the route parses", async () => {
    const capture = scripted(() => new Response(null, { status: 204 }));

    await putSessionSkills(() => ({ "X-Space-Id": "spc_a" }), "chs_1", {
      catalogue: false,
      pinned: ["@scope/a", "@scope/b"],
    });

    expect(String(capture.input)).toBe("/api/chat/sessions/chs_1/skills");
    expect(capture.init?.method).toBe("PUT");
    expect(capture.init?.credentials).toBe("include");
    expect(capture.init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Space-Id": "spc_a",
    });
    expect(JSON.parse(String(capture.init?.body))).toEqual({
      skill_catalogue: false,
      pinned_skills: ["@scope/a", "@scope/b"],
    });
  });

  it("throws when the server refuses the write", async () => {
    scripted(() => new Response(null, { status: 400 }));
    await expect(
      putSessionSkills(() => ({}), "chs_1", { catalogue: true, pinned: [] }),
    ).rejects.toThrow("HTTP 400");
  });
});
