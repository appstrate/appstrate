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
import { declaredColumns, declaredIndexes, diffColumns, runCheck } from "../check-index-drift.ts";
import {
  declaredTables,
  latestSnapshotName,
  type DrizzleJournal,
  type DrizzleSnapshot,
} from "../lib/drizzle-snapshots.ts";

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
 * Overlay column declarations onto a snapshot's tables: `table → column → NOT NULL`.
 *
 * Kept separate from `snapshot()` so every index case above stays exactly as it
 * was written — a table with no entry here declares no column, which is what a
 * snapshot with no `columns` key means.
 */
const withColumns = (
  snap: DrizzleSnapshot,
  columns: Record<string, Record<string, boolean>>,
): DrizzleSnapshot => ({
  tables: Object.fromEntries(
    Object.entries(snap.tables).map(([key, entry]) => [
      key,
      {
        ...entry,
        columns: Object.fromEntries(
          Object.entries(columns[key.slice(key.indexOf(".") + 1)] ?? {}).map(([name, notNull]) => [
            name,
            { name, type: "text", primaryKey: false, notNull },
          ]),
        ),
      },
    ]),
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

/**
 * `runCheck` with the healthy defaults filled in; every case overrides what it
 * is about. `actual` is `[index, table]` because the diff is restricted to the
 * tables the snapshot declares.
 */
const check = (over: {
  journal?: DrizzleJournal;
  trackingTableExists?: boolean;
  watermark?: number | null;
  actual?: [string, string][];
  /** `[table, column, NOT NULL]`, mirroring `PUBLIC_COLUMNS_QUERY`'s rows. */
  actualColumns?: [string, string, boolean][];
  constraintBacked?: string[];
  moduleTables?: Record<string, string>;
  snapshots?: Record<string, DrizzleSnapshot>;
}) =>
  runCheck({
    journal: over.journal ?? journal([0, 1]),
    trackingTableExists: over.trackingTableExists ?? true,
    watermark: over.watermark === undefined ? whenOf(1) : over.watermark,
    actual: (over.actual ?? []).map(([indexname, tablename]) => ({ indexname, tablename })),
    actualColumns: (over.actualColumns ?? []).map(([tablename, columnname, notnull]) => ({
      tablename,
      columnname,
      notnull,
    })),
    constraintBacked: new Set(over.constraintBacked ?? []),
    moduleTables: new Map(Object.entries(over.moduleTables ?? {})),
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
      actual: [
        ["account_user_id_idx", "account"],
        ["runs_pkey", "runs"],
      ],
      constraintBacked: ["runs_pkey"],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("  missing index   idx_runs_package_started");
    expect(lines.join("\n")).toContain("  missing index   idx_runs_schedule_id");
  });

  it("exits 0 and says definitions are not compared when nothing is missing", async () => {
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: [["idx_runs_schedule_id", "runs"]],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("No missing index");
    expect(lines.join("\n")).toContain("DEFINITIONS");
    expect(lines.join("\n")).not.toContain("missing index  ");
  });
});

describe("runCheck — column drift (#1349)", () => {
  it("exits 1 and names a declared column the database lacks", async () => {
    // The 42703 the Better Auth adapter check cannot see: it diffs the plugin's
    // expectations against the TS object, never against a database.
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": withColumns(snapshot({ oauth_clients: [] }), {
          oauth_clients: { id: true, is_first_party: true },
        }),
      },
      actualColumns: [["oauth_clients", "id", true]],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("  missing column  oauth_clients.is_first_party");
    expect(lines.join("\n")).not.toContain("missing column  oauth_clients.id");
  });

  it("exits 1 when a column exists but disagrees on NOT NULL", async () => {
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": withColumns(snapshot({ oauth_clients: [] }), {
          oauth_clients: { id: true, name: true },
        }),
      },
      actualColumns: [
        ["oauth_clients", "id", true],
        ["oauth_clients", "name", false],
      ],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain(
      "nullability     oauth_clients.name: database says nullable, snapshot declares NOT NULL",
    );
  });

  it("reports a missing index AND a missing column in the same run", async () => {
    // Fixing one and re-running to discover the other is a second deploy window.
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": withColumns(snapshot({ runs: ["idx_runs_schedule_id"] }), {
          runs: { id: true, schedule_id: false },
        }),
      },
      actual: [],
      actualColumns: [["runs", "id", true]],
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("  missing index   idx_runs_schedule_id");
    expect(lines.join("\n")).toContain("  missing column  runs.schedule_id");
  });

  it("names an undeclared column without failing the run", async () => {
    // Pre-squash residue: a column the schema stopped declaring with no forward
    // DROP COLUMN. An operator decides; the check does not.
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": withColumns(snapshot({ runs: [] }), { runs: { id: true } }),
      },
      actualColumns: [
        ["runs", "id", true],
        ["runs", "legacy_flow_id", false],
      ],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("  undeclared column  runs.legacy_flow_id");
    expect(lines.join("\n")).toContain("No missing column");
  });

  it("ignores columns on a table a MODULE owns", async () => {
    const { exitCode, lines } = await check({
      snapshots: {
        "0001_snapshot.json": withColumns(snapshot({ runs: [] }), { runs: { id: true } }),
      },
      actualColumns: [
        ["runs", "id", true],
        ["ee_usage_records", "credits", true],
      ],
      moduleTables: { ee_usage_records: "packages/module-ee" },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("ee_usage_records");
  });
});

describe("runCheck — undeclared indexes never fail the run", () => {
  it("counts a constraint-backed extra without naming it", async () => {
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: [
        ["idx_runs_schedule_id", "runs"],
        ["runs_pkey", "runs"],
      ],
      constraintBacked: ["runs_pkey"],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("constraint-backed (expected, not drift): 1");
    expect(lines.join("\n")).not.toContain("runs_pkey");
  });

  it("names an index no constraint owns as possible reverse drift, with its table", async () => {
    // The mirror of #1182: a squash dropped `idx_runs_legacy` from the schema
    // without a forward DROP INDEX, so pre-squash production still carries it.
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: [
        ["idx_runs_schedule_id", "runs"],
        ["idx_runs_legacy", "runs"],
      ],
      constraintBacked: [],
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("possible reverse drift  idx_runs_legacy  on runs");
  });

  it("ignores an index on a table a MODULE owns", async () => {
    // A module's tables migrate under a journal of its own: no platform snapshot declares them.
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: [
        ["idx_runs_schedule_id", "runs"],
        ["idx_ee_usage_records_org_id", "ee_usage_records"],
      ],
      moduleTables: { ee_usage_records: "packages/module-ee" },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("idx_ee_usage_records_org_id");
    expect(lines.join("\n")).toContain("Skipped 1 index(es) on 1 table(s) owned by");
    expect(lines.join("\n")).toContain("packages/module-ee");
  });

  it("REPORTS an index on a table NO module owns, naming the table", async () => {
    // Subtracting by "table the snapshot declares" instead would also drop a platform table the
    // schema stopped declaring — the reverse-drift class this script exists for.
    const { exitCode, lines } = await check({
      snapshots: { "0001_snapshot.json": snapshot({ runs: ["idx_runs_schedule_id"] }) },
      actual: [
        ["idx_runs_schedule_id", "runs"],
        ["idx_dropped_thing_org", "dropped_thing"],
      ],
      moduleTables: { ee_usage_records: "packages/module-ee" },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("undeclared table  dropped_thing");
    expect(lines.join("\n")).toContain(
      "possible reverse drift  idx_dropped_thing_org  on dropped_thing",
    );
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
      actual: [["idx_old", "runs"]],
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

describe("declaredColumns", () => {
  it("keys by table without the schema prefix and tolerates a table with no `columns`", () => {
    const declared = declaredColumns(
      withColumns(snapshot({ runs: [], account: null }), { runs: { id: true, note: false } }),
    );
    expect([...declared.get("runs")!]).toEqual([
      ["id", true],
      ["note", false],
    ]);
    expect([...declared.get("account")!]).toEqual([]);
  });

  it("ignores tables outside the public schema, which the column query never returns", () => {
    const declared = declaredColumns({
      tables: {
        "public.runs": { schema: "", columns: { id: { notNull: true } } },
        "audit.events": { schema: "audit", columns: { id: { notNull: true } } },
      },
    });
    expect([...declared.keys()]).toEqual(["runs"]);
  });
});

describe("diffColumns", () => {
  it("skips a declared table the database does not have at all", () => {
    // The index half already names it once; forty "missing column" lines under
    // it would bury that.
    const diff = diffColumns(new Map([["runs", new Map([["id", true]])]]), new Map());
    expect(diff).toEqual({ absent: [], nullability: [], undeclared: [] });
  });
});

describe("declaredTables", () => {
  it("strips the schema prefix and drops tables outside the public schema", () => {
    const tables = declaredTables({
      tables: {
        "public.runs": table(["idx_runs_schedule_id"]),
        "public.account": table(null),
        "audit.events": table(["idx_audit_events_at"], "audit"),
      },
    });
    expect([...tables].sort()).toEqual(["account", "runs"]);
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
