// SPDX-License-Identifier: Apache-2.0

/**
 * Index drift detector (issue #1182). The regression this pins is a SILENT one:
 * `0000_init.sql` is a squash production predates, so an index the squash
 * introduced exists in the schema, in the snapshot and in every dev database
 * while being absent from production.
 *
 * `runCheck` is where every decision lives — which snapshot to diff against,
 * the three refusals, the exit codes, the report — so it carries the bulk of
 * these tests. The pure helpers keep only the cases `runCheck` cannot reach.
 */

import { describe, it, expect } from "bun:test";
import {
  latestSnapshotName,
  declaredIndexes,
  runCheck,
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

/** `null` models a table with NO `indexes` key at all. */
const table = (names: string[] | null, schema = "") => ({
  schema,
  ...(names === null ? {} : { indexes: Object.fromEntries(names.map((n) => [n, index(n)])) }),
});

const snapshot = (tables: Record<string, string[] | null>): DrizzleSnapshot => ({
  tables: Object.fromEntries(
    Object.entries(tables).map(([name, names]) => [`public.${name}`, table(names)]),
  ),
});

/**
 * `when` is what drizzle stores verbatim in `drizzle.__drizzle_migrations.created_at`,
 * so the watermark cases below pass `whenOf(idx)`, never `idx`.
 */
const whenOf = (idx: number) => 1_779_844_679_760 + idx * 1000;

const journal = (idxs: number[]): DrizzleJournal => ({
  entries: idxs.map((idx) => ({
    idx,
    tag: `${String(idx).padStart(4, "0")}_migration`,
    when: whenOf(idx),
  })),
});

/** `runCheck` with the healthy defaults filled in; every case overrides what it is about. */
const check = (over: {
  journal?: DrizzleJournal;
  trackingTableExists?: boolean;
  watermark?: number | null;
  actual?: string[];
  constraintBacked?: string[];
  snapshots?: Record<string, DrizzleSnapshot>;
}) =>
  runCheck({
    journal: over.journal ?? journal([0, 1]),
    trackingTableExists: over.trackingTableExists ?? true,
    watermark: over.watermark === undefined ? whenOf(1) : over.watermark,
    actual: new Set(over.actual ?? []),
    constraintBacked: new Set(over.constraintBacked ?? []),
    loadSnapshot: async (name) => {
      const found = (over.snapshots ?? { "0001_snapshot.json": snapshot({}) })[name];
      if (!found) throw new Error(`test asked for an unstubbed snapshot: ${name}`);
      return found;
    },
  });

describe("runCheck — drift", () => {
  it("exits 1 and names every declared index the database lacks (#1182)", async () => {
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": snapshot({
          runs: ["idx_runs_package_started", "idx_runs_schedule_id"],
          account: ["account_user_id_idx"],
        }),
      },
      actual: ["account_user_id_idx", "runs_pkey"],
      constraintBacked: ["runs_pkey"],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("  missing  idx_runs_package_started");
    expect(lines.join("\n")).toContain("  missing  idx_runs_schedule_id");
  });

  it("exits 0 and says definitions are not compared when nothing is missing", async () => {
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: ["idx_runs_schedule_id"],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("No missing index");
    expect(lines.join("\n")).toContain("DEFINITIONS");
    expect(lines.join("\n")).not.toContain("missing  ");
  });
});

describe("runCheck — undeclared indexes never fail the run", () => {
  it("counts a constraint-backed extra without naming it", async () => {
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: ["idx_runs_schedule_id", "runs_pkey"],
      constraintBacked: ["runs_pkey"],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("constraint-backed (expected, not drift): 1");
    expect(lines.join("\n")).not.toContain("runs_pkey");
  });

  it("names an index no constraint owns as possible reverse drift, still exit 0", async () => {
    // The mirror of #1182: a squash dropped `idx_runs_legacy` from the schema
    // without a forward DROP INDEX, so pre-squash production still carries it.
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: ["idx_runs_schedule_id", "idx_runs_legacy"],
      constraintBacked: [],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("possible reverse drift  idx_runs_legacy");
  });
});

describe("runCheck — snapshot selection", () => {
  it("diffs a database that is behind against ITS snapshot, not the newest", async () => {
    // The deploy-time scenario: prod is at 0038, the repo carries 0041. Diffing
    // against 0041 would report every index the pending release adds as missing.
    const { exitCode, lines } = await check({
      journal: journal([38, 39, 40, 41]),
      watermark: whenOf(38),
      snapshots: { "0038_snapshot.json": snapshot({ runs: ["idx_old"] }) },
      actual: ["idx_old"],
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toBe(
      "Database is at 0038_migration; 3 migration(s) pending (latest on disk: " +
        "0041_snapshot.json). Diffing against 0038_snapshot.json.",
    );
  });

  it("says up to date when the watermark is the newest journal entry", async () => {
    const { lines } = await check({
      journal: journal([0, 1]),
      watermark: whenOf(1),
      snapshots: { "0001_snapshot.json": snapshot({}) },
    });
    expect(lines[0]).toBe(
      "Database is at 0001_migration (up to date). Diffing against 0001_snapshot.json.",
    );
  });
});

describe("runCheck — refusals never read as a clean result", () => {
  it("refuses when the tracking table does not exist", async () => {
    const { exitCode, lines } = await check({ trackingTableExists: false });
    expect(exitCode).toBe(1);
    expect(lines[0]).toContain("Cannot check");
    expect(lines[0]).toContain("never migrated");
  });

  it("refuses when the tracking table holds no applied migration", async () => {
    const { exitCode, lines } = await check({ watermark: null });
    expect(exitCode).toBe(1);
    expect(lines[0]).toContain("Cannot check");
    expect(lines[0]).toContain("is empty");
  });

  it("refuses a watermark matching no journal entry rather than snapping to a neighbour", async () => {
    // A squashed or hand-edited journal: the entry that produced this watermark
    // is gone. Guessing the nearest snapshot would diff against a schema the
    // database never had.
    const { exitCode, lines } = await check({ watermark: whenOf(1) + 1 });
    expect(exitCode).toBe(1);
    expect(lines[0]).toContain("Cannot check");
    expect(lines[0]).toContain("matches no entry");
  });
});

describe("declaredIndexes", () => {
  it("collects index keys and tolerates a table with no `indexes` key", () => {
    const declared = declaredIndexes(
      snapshot({
        runs: ["idx_runs_schedule_id"],
        account: ["account_user_id_idx"],
        sessions: null,
      }),
    );
    expect([...declared].sort()).toEqual(["account_user_id_idx", "idx_runs_schedule_id"]);
  });

  it("ignores tables outside the public schema, which pg_indexes never returns", () => {
    // Without the filter the first pgSchema(...) table with an index turns every
    // one of its indexes into a hard `missing` against a healthy database.
    const declared = declaredIndexes({
      tables: {
        "public.runs": table(["idx_runs_schedule_id"]),
        "audit.events": table(["idx_audit_events_at"], "audit"),
      },
    });
    expect([...declared]).toEqual(["idx_runs_schedule_id"]);
  });
});

describe("latestSnapshotName", () => {
  it("picks the highest idx from unsorted, non-contiguous entries and zero-pads it", () => {
    expect(latestSnapshotName(journal([7, 41, 3, 12]))).toBe("0041_snapshot.json");
  });

  it("throws rather than resolving a snapshot from an empty journal", () => {
    expect(() => latestSnapshotName({ entries: [] })).toThrow(/no entries/);
  });
});
