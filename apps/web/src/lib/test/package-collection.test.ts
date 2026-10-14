// SPDX-License-Identifier: Apache-2.0

/** What a collection's search, origin and activity leave on screen. */

import { describe, expect, it } from "bun:test";
import type { CardItem } from "../package-card-item.ts";
import { narrowPackages } from "../package-collection.ts";

const items: CardItem[] = [
  { id: "@acme/mine", displayName: "Mine", type: "agent", source: "local", runningRuns: 1 },
  { id: "@appstrate/sys", displayName: "Sys", type: "agent", source: "system" },
  { id: "@acme/bare", displayName: "Bare", type: "agent" },
];
const ids = (rows: CardItem[]) => rows.map((row) => row.id);

describe("narrowPackages", () => {
  it("keeps everything when nothing is chosen", () => {
    expect(ids(narrowPackages(items, { query: "", origins: [], holds: "agent" }))).toEqual(
      ids(items),
    );
  });

  it("narrows on origin, a package without one being local", () => {
    expect(ids(narrowPackages(items, { query: "", origins: ["local"], holds: "agent" }))).toEqual([
      "@acme/mine",
      "@acme/bare",
    ]);
    expect(ids(narrowPackages(items, { query: "", origins: ["system"], holds: "agent" }))).toEqual([
      "@appstrate/sys",
    ]);
    expect(
      narrowPackages(items, { query: "", origins: ["local", "system"], holds: "agent" }),
    ).toHaveLength(3);
  });

  it("narrows on activity only when one side is chosen", () => {
    const run = (activities: ("active" | "inactive")[]) =>
      ids(narrowPackages(items, { query: "", origins: [], activities, holds: "agent" }));
    expect(run(["active"])).toEqual(["@acme/mine"]);
    expect(run(["inactive"])).toEqual(["@appstrate/sys", "@acme/bare"]);
    expect(run(["active", "inactive"])).toHaveLength(3);
  });

  it("reads activity as use for a package that does not run", () => {
    const skills: CardItem[] = [
      { id: "@acme/used", displayName: "Used", type: "skill", usedByAgents: 2 },
      { id: "@acme/idle", displayName: "Idle", type: "skill" },
    ];
    expect(
      ids(
        narrowPackages(skills, { query: "", origins: [], activities: ["active"], holds: "skill" }),
      ),
    ).toEqual(["@acme/used"]);
  });

  it("combines search with the other dimensions", () => {
    expect(
      ids(narrowPackages(items, { query: "sys", origins: ["local"], holds: "agent" })),
    ).toEqual([]);
    expect(ids(narrowPackages(items, { query: "bare", origins: [], holds: "agent" }))).toEqual([
      "@acme/bare",
    ]);
  });
});
