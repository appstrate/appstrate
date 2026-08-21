// SPDX-License-Identifier: Apache-2.0

/**
 * Index drift detector (issue #1182). The regression this pins is a SILENT one:
 * `0000_init.sql` is a squash production predates, so an index the squash
 * introduced exists in the schema, in the snapshot and in every dev database
 * while being absent from production. The two indexes below are the two that
 * were actually missing.
 */

import { describe, it, expect } from "bun:test";
import {
  latestSnapshotName,
  declaredIndexes,
  diffIndexes,
  type DrizzleJournal,
  type DrizzleSnapshot,
} from "../check-index-drift.ts";

const index = (name: string) => ({
  name,
  columns: [],
  isUnique: false,
  concurrently: false,
  method: "btree",
  with: {},
});

const snapshot = (tables: Record<string, string[] | null>): DrizzleSnapshot => ({
  tables: Object.fromEntries(
    Object.entries(tables).map(([table, names]) => [
      `public.${table}`,
      // `null` models a table with NO `indexes` key at all.
      names === null
        ? {}
        : { indexes: Object.fromEntries(names.map((name) => [name, index(name)])) },
    ]),
  ),
});

const journal = (idxs: number[]): DrizzleJournal => ({
  entries: idxs.map((idx) => ({ idx, tag: `${String(idx).padStart(4, "0")}_migration` })),
});

describe("declaredIndexes", () => {
  it("collects the index keys of every table", () => {
    const declared = declaredIndexes(
      snapshot({
        runs: ["idx_runs_package_started", "idx_runs_schedule_id"],
        account: ["account_user_id_idx"],
      }),
    );
    expect([...declared].sort()).toEqual([
      "account_user_id_idx",
      "idx_runs_package_started",
      "idx_runs_schedule_id",
    ]);
  });

  it("does not throw on a table with no `indexes` key at all", () => {
    const declared = declaredIndexes(snapshot({ runs: ["idx_runs_schedule_id"], sessions: null }));
    expect([...declared]).toEqual(["idx_runs_schedule_id"]);
  });

  it("returns an empty set for a snapshot with no tables", () => {
    expect(declaredIndexes({ tables: {} }).size).toBe(0);
  });
});

describe("diffIndexes", () => {
  it("reports the two indexes #1182 found missing in production", () => {
    const declared = declaredIndexes(
      snapshot({
        runs: ["idx_runs_package_started", "idx_runs_schedule_id"],
        account: ["account_user_id_idx"],
      }),
    );
    const actual = new Set(["account_user_id_idx", "runs_pkey"]);

    const { missing, undeclared } = diffIndexes(declared, actual);
    expect(missing).toEqual(["idx_runs_package_started", "idx_runs_schedule_id"]);
    expect(undeclared).toEqual(["runs_pkey"]);
  });

  it("reports nothing missing when the database has every declared index", () => {
    const declared = declaredIndexes(snapshot({ runs: ["idx_runs_schedule_id"] }));
    const { missing, undeclared } = diffIndexes(declared, new Set(["idx_runs_schedule_id"]));
    expect(missing).toEqual([]);
    expect(undeclared).toEqual([]);
  });

  it("treats PK/unique-backed extras as undeclared, never as missing", () => {
    const declared = declaredIndexes(snapshot({ runs: ["idx_runs_schedule_id"] }));
    const actual = new Set(["idx_runs_schedule_id", "runs_pkey", "packages_scope_name_unique"]);

    const { missing, undeclared } = diffIndexes(declared, actual);
    expect(missing).toEqual([]);
    expect(undeclared).toEqual(["packages_scope_name_unique", "runs_pkey"]);
  });

  it("sorts both sides so the report is stable across runs", () => {
    const declared = new Set(["b_idx", "a_idx"]);
    const actual = new Set(["z_idx", "y_idx"]);
    const { missing, undeclared } = diffIndexes(declared, actual);
    expect(missing).toEqual(["a_idx", "b_idx"]);
    expect(undeclared).toEqual(["y_idx", "z_idx"]);
  });
});

describe("latestSnapshotName", () => {
  it("picks the highest idx and zero-pads it to 4 digits", () => {
    expect(latestSnapshotName(journal([0, 1, 2, 40]))).toBe("0040_snapshot.json");
  });

  it("picks the highest idx from unsorted, non-contiguous entries", () => {
    expect(latestSnapshotName(journal([7, 41, 3, 12]))).toBe("0041_snapshot.json");
  });

  it("pads a single-digit idx", () => {
    expect(latestSnapshotName(journal([0]))).toBe("0000_snapshot.json");
  });

  it("throws rather than resolving a snapshot from an empty journal", () => {
    expect(() => latestSnapshotName({ entries: [] })).toThrow(/no entries/);
  });
});
