// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { describe, expect, it } from "bun:test";
import { fetchSkills, skillPickerRows, togglePinned } from "../src/ui/chat-skills.ts";
import { requestAnswering, transportOver } from "./fake-request.ts";

describe("fetchSkills", () => {
  it("GETs the organization listing and parses its rows", async () => {
    const request = requestAnswering(() =>
      Response.json({
        data: [
          {
            id: "@acme/tone",
            name: "Tone",
            description: null,
            version: "1.2.0",
            space_ids: ["spc_a"],
          },
        ],
      }),
    );

    const got = await fetchSkills(transportOver(request), ["spc_a"]);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/packages/skills"]);
    expect(got).toEqual([
      { packageId: "@acme/tone", display_name: "Tone", description: null, version: "1.2.0" },
    ]);
  });

  it("keeps the skills active in a space the chat acts in", async () => {
    const row = (id: string, ...space_ids: string[]) => ({
      id,
      name: id,
      description: null,
      version: "1.0.0",
      space_ids,
    });
    const request = requestAnswering(() =>
      Response.json({
        data: [
          row("@acme/a", "spc_view"),
          row("@acme/b", "spc_other", "spc_act"),
          row("@acme/c", "spc_act"),
        ],
      }),
    );
    const transport = transportOver(request);

    const got = await fetchSkills(transport, ["spc_act"]);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/packages/skills"]);
    expect(got.map((skill) => skill.packageId)).toEqual(["@acme/b", "@acme/c"]);
    // No acting space: nothing is offered.
    expect(await fetchSkills(transport, [])).toEqual([]);
  });

  it("drops a row that lists no spaces", async () => {
    const request = requestAnswering(() =>
      Response.json({
        data: [
          { id: "@acme/a", name: "A", description: null, version: "1.0.0" },
          { id: "@acme/b", name: "B", description: null, version: "1.0.0", space_ids: "spc_a" },
          { id: "@acme/c", name: "C", description: null, version: "1.0.0", space_ids: ["spc_a"] },
        ],
      }),
    );
    const got = await fetchSkills(transportOver(request), ["spc_a"]);
    expect(got.map((skill) => skill.packageId)).toEqual(["@acme/c"]);
  });

  it("throws on a refusal, as the host raised it", async () => {
    const request = requestAnswering(() => new Response(null, { status: 403 }));
    await expect(fetchSkills(transportOver(request), [])).rejects.toMatchObject({ status: 403 });
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

  it("has no rows for an empty catalogue and no pins", () => {
    expect(skillPickerRows([], [])).toEqual([]);
  });
});
