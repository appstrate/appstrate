// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { filterMemoryItems, memoryScopeOf } from "../memory-items";

const ME = "u_me";

const item = (
  id: number,
  kind: "pinned" | "archive",
  actor_type: PersistenceActorType,
  content: unknown,
  key: string | null = null,
  actor_id: string | null = actor_type === "shared" ? null : ME,
) => ({ id, kind, key, content, actor_type, actor_id });

const ITEMS = [
  item(1, "pinned", "shared", "team goals", "goals"),
  item(2, "pinned", "user", { step: 3 }, "checkpoint"),
  item(3, "archive", "shared", "invoice sent to ACME"),
  item(4, "archive", "user", "prefers French"),
  item(5, "archive", "user", "a colleague's note", null, "u_colleague"),
  item(6, "archive", "end_user", "an end-user's note", null, "eu_1"),
];
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
const NONE = { query: "", scopes: [], types: [] };

describe("filterMemoryItems", () => {
  it("keeps everything when no filter is set", () => {
    expect(ids(filterMemoryItems(ITEMS, NONE, ME))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("filters by tier", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, types: ["pinned"] }, ME))).toEqual([1, 2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, types: ["archive"] }, ME))).toEqual([
      3, 4, 5, 6,
    ]);
  });

  it("reads only the signed-in user's rows as theirs, every other actor as others", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, scopes: ["shared"] }, ME))).toEqual([1, 3]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, scopes: ["mine"] }, ME))).toEqual([2, 4]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, scopes: ["others"] }, ME))).toEqual([5, 6]);
  });
});

describe("memoryScopeOf", () => {
  it("never reads an end-user row as the signed-in user's, even on an id clash", () => {
    expect(memoryScopeOf({ actor_type: "end_user", actor_id: ME }, ME)).toBe("others");
  });

  it("reads no row as the user's own before the user is known", () => {
    expect(memoryScopeOf({ actor_type: "user", actor_id: ME }, undefined)).toBe("others");
  });

  it("searches the key and the content, JSON included", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "checkpoint" }, ME))).toEqual([2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "step" }, ME))).toEqual([2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "acme" }, ME))).toEqual([3]);
  });

  it("combines the filters", () => {
    expect(
      ids(filterMemoryItems(ITEMS, { query: "", scopes: ["shared"], types: ["archive"] }, ME)),
    ).toEqual([3]);
  });
});
