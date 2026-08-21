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
  snapshotNameForWatermark,
  declaredIndexes,
  diffIndexes,
  classifyUndeclared,
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

/**
 * `when` is what drizzle stores verbatim in `drizzle.__drizzle_migrations.created_at`,
 * so the watermark tests below compare against `whenOf(idx)`, never against `idx`.
 */
const whenOf = (idx: number) => 1_779_844_679_760 + idx * 1000;

const journal = (idxs: number[]): DrizzleJournal => ({
  entries: idxs.map((idx) => ({
    idx,
    tag: `${String(idx).padStart(4, "0")}_migration`,
    when: whenOf(idx),
  })),
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

describe("snapshotNameForWatermark", () => {
  it("resolves the snapshot whose journal `when` equals the watermark", () => {
    const at = snapshotNameForWatermark(journal([0, 1, 2, 3]), whenOf(2));
    expect(at).toEqual({ snapshotName: "0002_snapshot.json", tag: "0002_migration", pending: 1 });
  });

  it("reports 0 pending when the database is at the newest journal entry", () => {
    const at = snapshotNameForWatermark(journal([0, 1, 2, 3]), whenOf(3));
    expect(at?.pending).toBe(0);
    expect(at?.snapshotName).toBe("0003_snapshot.json");
  });

  it("diffs a database that is behind against ITS snapshot, not the newest (#1182 follow-up)", () => {
    // The deploy-time scenario: prod is at 0038, the repo carries 0041. Diffing
    // against 0041 would report every index the pending release adds as missing.
    const j = journal([36, 37, 38, 39, 40, 41]);
    const at = snapshotNameForWatermark(j, whenOf(38));
    expect(at?.snapshotName).toBe("0038_snapshot.json");
    expect(at?.pending).toBe(3);
    expect(latestSnapshotName(j)).toBe("0041_snapshot.json");
  });

  it("counts pending from `when`, not from position, on an unsorted journal", () => {
    const at = snapshotNameForWatermark(journal([5, 1, 9, 3]), whenOf(3));
    expect(at?.snapshotName).toBe("0003_snapshot.json");
    expect(at?.pending).toBe(2);
  });

  it("returns null for a watermark matching no entry rather than snapping to a neighbour", () => {
    // A squashed or hand-edited journal: the entry that produced this watermark
    // is gone. Guessing the nearest snapshot would diff against a schema the
    // database never had.
    expect(snapshotNameForWatermark(journal([0, 1, 2]), whenOf(1) + 1)).toBeNull();
    expect(snapshotNameForWatermark(journal([0, 1, 2]), whenOf(7))).toBeNull();
  });

  it("returns null on an empty journal instead of throwing", () => {
    expect(snapshotNameForWatermark({ entries: [] }, whenOf(0))).toBeNull();
  });
});

describe("classifyUndeclared", () => {
  it("counts constraint-backed extras as expected and never as drift", () => {
    const { expected, reverseDrift } = classifyUndeclared(
      ["packages_scope_name_unique", "runs_pkey"],
      new Set(["packages_scope_name_unique", "runs_pkey"]),
    );
    expect(expected).toEqual(["packages_scope_name_unique", "runs_pkey"]);
    expect(reverseDrift).toEqual([]);
  });

  it("names an index no constraint owns as possible reverse drift", () => {
    // The mirror of #1182: the squash dropped `idx_runs_legacy` from the schema
    // without a forward DROP INDEX, so pre-squash production still carries it.
    const { expected, reverseDrift } = classifyUndeclared(
      ["idx_runs_legacy", "runs_pkey"],
      new Set(["runs_pkey"]),
    );
    expect(expected).toEqual(["runs_pkey"]);
    expect(reverseDrift).toEqual(["idx_runs_legacy"]);
  });

  it("does not label a standalone unique index as constraint-backed", () => {
    // Justifies joining pg_constraint rather than testing pg_index.indisunique:
    // a hand-written CREATE UNIQUE INDEX has no constraint row, so it must stay
    // visible as reverse drift instead of being dismissed.
    const { expected, reverseDrift } = classifyUndeclared(["idx_orphan_unique"], new Set());
    expect(expected).toEqual([]);
    expect(reverseDrift).toEqual(["idx_orphan_unique"]);
  });

  it("preserves the sorted order diffIndexes produced", () => {
    const { undeclared } = diffIndexes(new Set(), new Set(["c_idx", "a_idx", "b_idx"]));
    const { reverseDrift } = classifyUndeclared(undeclared, new Set(["b_idx"]));
    expect(reverseDrift).toEqual(["a_idx", "c_idx"]);
  });

  it("returns two empty buckets when nothing is undeclared", () => {
    expect(classifyUndeclared([], new Set(["runs_pkey"]))).toEqual({
      expected: [],
      reverseDrift: [],
    });
  });
});
