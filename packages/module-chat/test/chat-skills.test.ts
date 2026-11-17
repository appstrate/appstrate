// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { describe, expect, it } from "bun:test";
import {
  fetchEnforcedSkills,
  fetchSkills,
  ownPins,
  pinCapReached,
  skillPickerRows,
  togglePinned,
} from "../src/ui/chat-skills.ts";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";
import { requestAnswering } from "./fake-request.ts";

describe("fetchSkills", () => {
  it("GETs the space listing and parses its rows", async () => {
    const request = requestAnswering(() =>
      Response.json({
        data: [{ id: "@acme/tone", name: "Tone", description: null, version: "1.2.0" }],
      }),
    );

    const got = await fetchSkills(request);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/packages/skills"]);
    expect(got).toEqual([
      { packageId: "@acme/tone", display_name: "Tone", description: null, version: "1.2.0" },
    ]);
  });

  it("throws on a refusal, as the host raised it", async () => {
    const request = requestAnswering(() => new Response(null, { status: 403 }));
    await expect(fetchSkills(request)).rejects.toMatchObject({ status: 403 });
  });
});

describe("fetchEnforcedSkills", () => {
  it("GETs the chat read and parses its rows", async () => {
    const request = requestAnswering(() =>
      Response.json({
        object: "list",
        data: [
          { id: "@acme/tone", name: "Tone", version: "1.2.0" },
          { id: "@acme/gone", name: "Gone", version: null },
        ],
      }),
    );

    const got = await fetchEnforcedSkills(request);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/chat/enforced-skills"]);
    expect(got).toEqual([
      { packageId: "@acme/tone", display_name: "Tone", version: "1.2.0" },
      { packageId: "@acme/gone", display_name: "Gone", version: null },
    ]);
  });

  it("throws on a refusal", async () => {
    const request = requestAnswering(() => new Response(null, { status: 503 }));
    await expect(fetchEnforcedSkills(request)).rejects.toMatchObject({ status: 503 });
  });

  // Fail closed: a drifted policy read is an error, never "nothing imposed".
  for (const [label, body] of [
    ["a malformed row", { object: "list", data: [{ id: 42, name: "x", version: null }] }],
    ["a missing envelope", [{ id: "@acme/tone", name: "Tone", version: null }]],
    ["a missing data member", { object: "list" }],
  ] as const) {
    it(`throws on ${label}`, async () => {
      const request = requestAnswering(() => Response.json(body));
      await expect(fetchEnforcedSkills(request)).rejects.toThrow("Unexpected");
    });
  }
});

describe("ownPins", () => {
  it("drops the pins naming an enforced skill, keeping the order of the rest", () => {
    expect(ownPins(["@a/x", "@s/enforced", "@b/y"], new Set(["@s/enforced"]))).toEqual([
      "@a/x",
      "@b/y",
    ]);
  });

  it("keeps every pin when the space enforces nothing", () => {
    expect(ownPins(["@a/x"], new Set())).toEqual(["@a/x"]);
  });
});

describe("pinCapReached", () => {
  const own = Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@a/own-${i}`);

  it("does not count a stored pin naming an enforced skill", () => {
    const stored = [...own, "@s/enforced"];
    expect(stored.length).toBe(MAX_PINNED_SKILLS);
    expect(pinCapReached(stored, new Set(["@s/enforced"]))).toBe(false);
  });

  it("CONTROL: the same pins with nothing enforced reach the cap", () => {
    expect(pinCapReached([...own, "@s/enforced"], new Set())).toBe(true);
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
      { skill: { packageId: "@acme/gone", display_name: "gone" }, available: false },
      { skill: { packageId: "@z/deleted", display_name: "deleted" }, available: false },
    ]);
  });

  it("still lists dead pins when the catalogue is empty", () => {
    expect(skillPickerRows([], ["@acme/gone"])).toEqual([
      { skill: { packageId: "@acme/gone", display_name: "gone" }, available: false },
    ]);
  });

  it("lists an enforced skill neither as choosable nor as a dead pin", () => {
    const policy = { ...tone, packageId: "@acme/policy" };
    expect(
      skillPickerRows([policy, tone], ["@acme/policy", "@acme/gone"], new Set(["@acme/policy"])),
    ).toEqual([
      { skill: tone, available: true },
      { skill: { packageId: "@acme/gone", display_name: "gone" }, available: false },
    ]);
    // Enforced but absent from the caller's catalogue: still not a dead pin.
    expect(skillPickerRows([], ["@acme/policy"], new Set(["@acme/policy"]))).toEqual([]);
  });

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
