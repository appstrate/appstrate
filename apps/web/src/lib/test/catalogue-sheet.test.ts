// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { sheetChatEnforce, sheetSpaceRows } from "../catalogue-sheet.ts";
import type { CataloguePlacement } from "../catalogue-placement.ts";
import type { ActivationGate } from "../catalogue-gates.ts";

function placement(overrides: Partial<CataloguePlacement> = {}): CataloguePlacement {
  return {
    here: null,
    activeIn: [],
    inactiveIn: [],
    offeredIn: [],
    offeredBy: {},
    homeSpaceId: null,
    ...overrides,
  };
}

const ALLOW = (): ActivationGate => ({ allowed: true, refusal: null });
const DENY = (): ActivationGate => ({ allowed: false, refusal: "activate" });

const spaces = [
  { id: "spc_a", name: "Default" },
  { id: "spc_b", name: "Bac à sable" },
];

describe("sheetSpaceRows", () => {
  it("puts the reader's own space first", () => {
    const rows = sheetSpaceRows(placement({}), spaces, ALLOW, "spc_b");
    expect(rows[0]?.id).toBe("spc_b");
    expect(rows).toHaveLength(spaces.length);
  });

  it("reads each space's state, its home and who offered it", () => {
    const rows = sheetSpaceRows(
      placement({
        activeIn: ["spc_a"],
        offeredIn: ["spc_b"],
        offeredBy: { spc_b: "Bob Martin" },
        homeSpaceId: "spc_a",
      }),
      spaces,
      ALLOW,
    );
    expect(rows).toEqual([
      {
        id: "spc_a",
        name: "Default",
        state: "active",
        home: true,
        offeredBy: null,
        mayToggle: true,
        refusal: null,
      },
      {
        id: "spc_b",
        name: "Bac à sable",
        state: "offered",
        home: false,
        offeredBy: "Bob Martin",
        mayToggle: true,
        refusal: null,
      },
    ]);
  });

  it("asks the verdict in the direction the switch would go", () => {
    const asked: Array<[string, boolean]> = [];
    sheetSpaceRows(placement({ activeIn: ["spc_a"] }), spaces, (id, next) => {
      asked.push([id, next]);
      return ALLOW();
    });
    expect(asked).toEqual([
      ["spc_a", false],
      ["spc_b", true],
    ]);
  });
});

describe("sheetSpaceRows refusals", () => {
  it("carries the gate's reason beside a dead switch", () => {
    const rows = sheetSpaceRows(placement(), spaces.slice(0, 1), DENY);
    expect(rows[0]).toMatchObject({ mayToggle: false, refusal: "activate" });
  });
});

// The chat-enforce control lives in the sheet's Espaces table.
describe("sheetChatEnforce", () => {
  const facts = { enforced: false, published: true, mayConfigure: true };

  it("is offered on a placed, published skill to a caller who may configure the space", () => {
    expect(sheetChatEnforce("skill", { state: "active" }, facts)).toEqual({
      checked: false,
      disabled: false,
      refusal: null,
    });
  });

  it("waits for a published version: what is imposed is never the draft", () => {
    expect(sheetChatEnforce("skill", { state: "active" }, { ...facts, published: false })).toEqual({
      checked: false,
      disabled: true,
      refusal: "publishFirst",
    });
  });

  it("is refused without the space's configure right, personal owner included", () => {
    expect(
      sheetChatEnforce("skill", { state: "active" }, { ...facts, mayConfigure: false }),
    ).toEqual({ checked: false, disabled: true, refusal: "configure" });
  });

  it("can still be released on a skill switched off there, even unpublished", () => {
    expect(
      sheetChatEnforce(
        "skill",
        { state: "inactive" },
        { ...facts, enforced: true, published: false },
      ),
    ).toEqual({ checked: true, disabled: false, refusal: null });
  });

  it("draws no switch where there is no placement to configure", () => {
    expect(sheetChatEnforce("skill", { state: "offered" }, facts)).toBeNull();
    expect(sheetChatEnforce("skill", { state: null }, facts)).toBeNull();
  });

  it("draws no switch for any other type", () => {
    for (const type of ["agent", "integration", "mcp-server"] as const) {
      expect(sheetChatEnforce(type, { state: "active" }, facts)).toBeNull();
    }
  });
});
