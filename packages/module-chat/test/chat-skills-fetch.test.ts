// SPDX-License-Identifier: Apache-2.0

/**
 * The two skill requests of the picker, pinned against a scripted `fetch`:
 * nothing else checks their URL, method, or the snake_case body the server parses.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { fetchSkills, putSessionSkills, skillWriteSettled } from "../src/ui/sessions.ts";

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

describe("fetchSkills", () => {
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

    const got = await fetchSkills(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

    expect(String(capture.input)).toBe("/api/packages/skills");
    expect(capture.init?.credentials).toBe("include");
    expect(capture.init?.headers).toEqual({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });
    expect(got).toEqual([
      {
        packageId: "@acme/tone",
        display_name: "Tone",
        description: "Adjusts tone",
        version: "1.2.0",
      },
      { packageId: "@acme/bare", display_name: "@acme/bare", description: null, version: null },
    ]);
  });

  it("throws on a refusal: the picker is not mounted for a caller who cannot read skills", async () => {
    scripted(() => new Response(null, { status: 403 }));
    await expect(fetchSkills(() => ({}))).rejects.toThrow("HTTP 403");
  });
});

describe("putSessionSkills", () => {
  it("PUTs the snake_case body the route parses", async () => {
    const capture = scripted(() => new Response(null, { status: 204 }));

    await putSessionSkills(() => ({ "X-Space-Id": "spc_a" }), "chs_1", {
      skillCatalogue: false,
      pinnedSkills: ["@scope/a", "@scope/b"],
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
      putSessionSkills(() => ({}), "chs_1", { skillCatalogue: true, pinnedSkills: [] }),
    ).rejects.toThrow("HTTP 400");
  });
});

describe("skillWriteSettled", () => {
  it("holds a send until the session's write has answered, success or refusal", async () => {
    for (const status of [204, 500]) {
      let answer!: () => void;
      globalThis.fetch = (() =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(new Response(null, { status }));
        })) as unknown as typeof fetch;
      const write = putSessionSkills(() => ({}), "chs_w", {
        skillCatalogue: true,
        pinnedSkills: [],
      }).catch(() => {});
      let settled = false;
      const waiting = skillWriteSettled("chs_w").then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      answer();
      await waiting;
      await write;
      expect(settled).toBe(true);
    }
    // Another session never waits on this one.
    expect(await skillWriteSettled("chs_other")).toBeUndefined();
  });
});
