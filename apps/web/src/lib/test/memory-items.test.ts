// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { filterMemoryItems } from "../memory-items";

const item = (
  id: number,
  kind: "pinned" | "archive",
  actor_type: PersistenceActorType,
  content: unknown,
  key: string | null = null,
) => ({ id, kind, key, content, actor_type });

const ITEMS = [
  item(1, "pinned", "shared", "team goals", "goals"),
  item(2, "pinned", "user", { step: 3 }, "checkpoint"),
  item(3, "archive", "shared", "invoice sent to ACME"),
  item(4, "archive", "end_user", "prefers French"),
];
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
const NONE = { query: "", scopes: [], types: [] };

describe("filterMemoryItems", () => {
  it("keeps everything when no filter is set", () => {
    expect(ids(filterMemoryItems(ITEMS, NONE))).toEqual([1, 2, 3, 4]);
  });

  it("filters by tier", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, types: ["pinned"] }))).toEqual([1, 2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, types: ["archive"] }))).toEqual([3, 4]);
  });

  it("reads every non-shared actor as the caller's own", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, scopes: ["shared"] }))).toEqual([1, 3]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, scopes: ["mine"] }))).toEqual([2, 4]);
  });

  it("searches the key and the content, JSON included", () => {
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "checkpoint" }))).toEqual([2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "step" }))).toEqual([2]);
    expect(ids(filterMemoryItems(ITEMS, { ...NONE, query: "acme" }))).toEqual([3]);
  });

  it("combines the filters", () => {
    expect(
      ids(filterMemoryItems(ITEMS, { query: "", scopes: ["shared"], types: ["archive"] })),
    ).toEqual([3]);
  });
});
