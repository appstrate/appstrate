// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { sheetOffers, sheetSpaceMode, sheetSpaceRows } from "../catalogue-sheet.ts";
import type { CataloguePlacement } from "../catalogue-placement.ts";

function placement(overrides: Partial<CataloguePlacement> = {}): CataloguePlacement {
  return {
    here: null,
    activeIn: [],
    inactiveIn: [],
    offeredIn: [],
    offeredBy: {},
    homeSpaceId: null,
    unplaced: false,
    ...overrides,
  };
}

const spaces = [
  { id: "spc_a", name: "Default" },
  { id: "spc_b", name: "Bac à sable" },
];

describe("sheetSpaceRows", () => {
  it("reads each space's state, its home and who offered it", () => {
    const rows = sheetSpaceRows(
      placement({
        activeIn: ["spc_a"],
        offeredIn: ["spc_b"],
        offeredBy: { spc_b: "Julie Ferrand" },
        homeSpaceId: "spc_a",
      }),
      spaces,
      () => true,
    );
    expect(rows).toEqual([
      {
        id: "spc_a",
        name: "Default",
        state: "active",
        home: true,
        offeredBy: null,
        mayToggle: true,
      },
      {
        id: "spc_b",
        name: "Bac à sable",
        state: "offered",
        home: false,
        offeredBy: "Julie Ferrand",
        mayToggle: true,
      },
    ]);
  });

  it("asks the verdict in the direction the switch would go", () => {
    const asked: Array<[string, boolean]> = [];
    sheetSpaceRows(placement({ activeIn: ["spc_a"] }), spaces, (id, next) => {
      asked.push([id, next]);
      return true;
    });
    expect(asked).toEqual([
      ["spc_a", false],
      ["spc_b", true],
    ]);
  });
});

describe("sheetSpaceMode", () => {
  it("is read-only when the reader may switch it nowhere", () => {
    const p = placement({ activeIn: ["spc_a"] });
    expect(sheetSpaceMode(sheetSpaceRows(p, spaces, () => false))).toBe("readonly");
  });

  it("is one line, not a table, with one space within reach", () => {
    const p = placement();
    expect(sheetSpaceMode(sheetSpaceRows(p, spaces.slice(0, 1), () => true))).toBe("single");
  });

  it("is a table as soon as there are two spaces to compare", () => {
    const p = placement();
    expect(sheetSpaceMode(sheetSpaceRows(p, spaces, (id) => id === "spc_b"))).toBe("table");
  });
});

describe("sheetOffers", () => {
  it("keeps the offers alone", () => {
    const p = placement({ activeIn: ["spc_a"], offeredIn: ["spc_b"] });
    expect(sheetOffers(sheetSpaceRows(p, spaces, () => true)).map((row) => row.id)).toEqual([
      "spc_b",
    ]);
  });
});
