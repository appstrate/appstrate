// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  pinnedVersionState,
  sheetChatEnforce,
  sheetSpaceMode,
  sheetSpaceRows,
} from "../catalogue-sheet.ts";
import type { CataloguePlacement } from "../catalogue-placement.ts";
import type { ActivationGate } from "../catalogue-gates.ts";

function placement(overrides: Partial<CataloguePlacement> = {}): CataloguePlacement {
  return {
    here: null,
    activeIn: [],
    inactiveIn: [],
    sharedBy: {},
    homeSpaceId: null,
    unplaced: false,
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

  it("reads each space's state, its home and who shared it", () => {
    const rows = sheetSpaceRows(
      placement({
        activeIn: ["spc_a"],
        inactiveIn: ["spc_b"],
        sharedBy: { spc_b: "Bob Martin" },
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
        shared: false,
        sharedBy: null,
        mayToggle: true,
        refusal: null,
      },
      {
        id: "spc_b",
        name: "Bac à sable",
        state: "inactive",
        home: false,
        shared: true,
        sharedBy: "Bob Martin",
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

describe("sheetSpaceMode", () => {
  it("is read-only when the reader may switch it nowhere", () => {
    const p = placement({ activeIn: ["spc_a"] });
    expect(sheetSpaceMode(sheetSpaceRows(p, spaces, DENY))).toBe("readonly");
  });

  it("is one line, not a table, with one space within reach", () => {
    const p = placement();
    expect(sheetSpaceMode(sheetSpaceRows(p, spaces.slice(0, 1), ALLOW))).toBe("single");
  });

  it("is a table as soon as there are two spaces to compare", () => {
    const p = placement();
    expect(
      sheetSpaceMode(sheetSpaceRows(p, spaces, (id) => (id === "spc_b" ? ALLOW() : DENY()))),
    ).toBe("table");
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
    expect(sheetChatEnforce("skill", { state: null }, facts)).toBeNull();
  });

  it("draws no switch for any other type", () => {
    for (const type of ["agent", "integration", "mcp-server"] as const) {
      expect(sheetChatEnforce(type, { state: "active" }, facts)).toBeNull();
    }
  });
});

describe("pinnedVersionState", () => {
  const read = { pinned: "1.0.0", missing: false, latestPublished: "2.0.0" };

  it("has nothing to say about a sheet no version was pinned on", () => {
    expect(pinnedVersionState({ ...read, pinned: undefined })).toBeNull();
  });

  it("names a version the server no longer has", () => {
    expect(pinnedVersionState({ ...read, missing: true })).toBe("missing");
  });

  it("warns when the spaces run a newer version than the one read", () => {
    expect(pinnedVersionState(read)).toBe("behind");
  });

  it("is current on the latest version, and while the latest is still unknown", () => {
    expect(pinnedVersionState({ ...read, pinned: "2.0.0" })).toBe("current");
    expect(pinnedVersionState({ ...read, latestPublished: undefined })).toBe("current");
  });
});
