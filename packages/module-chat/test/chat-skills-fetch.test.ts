// SPDX-License-Identifier: Apache-2.0

/**
 * The two skill requests of the picker, pinned against a scripted `fetch`:
 * nothing else checks their URL, method, or the snake_case body the server parses.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { fetchSkills } from "../src/ui/sessions.ts";

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
