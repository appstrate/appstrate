// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { afterEach, describe, expect, it } from "bun:test";
import { fetchSkills, skillPickerRows, togglePinned } from "../src/ui/chat-skills.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchSkills", () => {
  it("GETs the space listing with the scoping headers and parses its rows", async () => {
    let input: RequestInfo | URL | undefined;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (i: RequestInfo | URL, o?: RequestInit) => {
      input = i;
      init = o;
      return Response.json({
        data: [{ id: "@acme/tone", name: "Tone", description: null, version: "1.2.0" }],
      });
    }) as typeof fetch;

    const got = await fetchSkills(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

    expect(String(input)).toBe("/api/packages/skills");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toEqual({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });
    expect(got).toEqual([
      { packageId: "@acme/tone", display_name: "Tone", description: null, version: "1.2.0" },
    ]);
  });

  it("throws on a refusal", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(null, { status: 403 })) as typeof fetch;
    await expect(fetchSkills(() => ({}))).rejects.toThrow("HTTP 403");
  });
});

describe("togglePinned", () => {
  it("adds and removes", () => {
    expect(togglePinned(["@b/x"], "@a/y")).toEqual(["@b/x", "@a/y"]);
    expect(togglePinned(["@a/y", "@b/x"], "@a/y")).toEqual(["@b/x"]);
  });
});

describe("skillPickerRows", () => {
  const tone = {
    packageId: "@acme/tone",
    display_name: "Tone",
    description: null,
    version: "1.0.0",
  };

  it("lists the catalogue as available rows, in its order", () => {
    const pdf = { ...tone, packageId: "@acme/pdf" };
    expect(skillPickerRows([tone, pdf], ["@acme/pdf"])).toEqual([
      { skill: tone, available: true },
      { skill: pdf, available: true },
    ]);
  });

  it("appends every pin the catalogue no longer lists, so it can be unpinned", () => {
    expect(skillPickerRows([tone], ["@acme/gone", "@acme/tone", "@z/deleted"])).toEqual([
      { skill: tone, available: true },
      { skill: { packageId: "@acme/gone" }, available: false },
      { skill: { packageId: "@z/deleted" }, available: false },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      { skill: { packageId: "@acme/gone" }, available: false },
    ]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
