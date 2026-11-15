#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0048 — package shares folded into `space_packages` (#2045):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0048-fold-package-shares.ts [--apply]
 *
 * Run after drizzle `0100` has applied and BEFORE the app starts (`pg_dump`
 * first): the platform refuses to boot while `package_shares` holds a row
 * (`assertPackageSharesFolded`). Dry run by default (rolled back); `--apply`
 * commits; a second `--apply` writes nothing. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`).
 *
 * Per share: insert its (space, package) row `enabled = false` with `shared_by`
 * (`ON CONFLICT DO NOTHING`; an existing row only gains `shared_by`). A share
 * across organizations is skipped and printed. An org package's row outside its
 * home with no same-org share is an ORPHAN: printed and deleted, since the new
 * rule would place the package there. Per-space placements before and after must
 * be equal or the transaction rolls back; then `package_shares` is emptied.
 * With it already empty nothing is checked, so orphans are only told apart
 * while shares remain.
 */

import { parseArgs } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";

class DryRunRollback extends Error {}

export interface SkippedPackageShare {
  packageId: string;
  spaceId: string;
}

export interface SpacePlacements {
  spaceId: string;
  before: number;
  after: number;
}

export interface OrphanPlacement {
  packageId: string;
  spaceId: string;
  enabled: boolean;
  /** The row's space belongs to another organization than the package. */
  crossOrg: boolean;
}

export interface PackageSharesFold {
  inserted: number;
  /** Existing rows whose `shared_by` was copied from their share. */
  sharedByCopied: number;
  /** Shares naming a space of another organization than the package's — deleted, not folded. */
  skipped: SkippedPackageShare[];
  /** Rows that placed their package nowhere under the old rule — deleted. */
  orphans: OrphanPlacement[];
  /** `package_shares` rows deleted once folded. */
  emptied: number;
  placements: SpacePlacements[];
}

/** Every share whose space and package belong to the same organization. */
const FOLDABLE = sql`package_shares ps
  JOIN spaces s ON s.id = ps.space_id
  JOIN packages p ON p.id = ps.package_id AND p.org_id = s.org_id`;

/** The old rule, read before the fold: system (its rows) ∨ home ∨ a same-org share. */
const PLACEMENTS_BEFORE = sql`SELECT space_id, count(DISTINCT package_id)::int AS n FROM (
    SELECT home_space_id AS space_id, id AS package_id FROM packages WHERE home_space_id IS NOT NULL
    UNION SELECT ps.space_id, ps.package_id FROM ${FOLDABLE}
    UNION SELECT sp.space_id, sp.package_id FROM space_packages sp
      JOIN packages p ON p.id = sp.package_id WHERE p.org_id IS NULL
  ) placed GROUP BY space_id`;

/** An org package's row outside its home with no same-org share. */
const ORPHANS = sql`space_packages sp
  JOIN packages p ON p.id = sp.package_id
  JOIN spaces s ON s.id = sp.space_id
  WHERE p.org_id IS NOT NULL
    AND sp.space_id IS DISTINCT FROM p.home_space_id
    AND NOT EXISTS (SELECT 1 FROM ${FOLDABLE}
      WHERE ps.package_id = sp.package_id AND ps.space_id = sp.space_id)`;

const PLACEMENTS_AFTER = sql`SELECT space_id, count(DISTINCT package_id)::int AS n FROM (
    SELECT home_space_id AS space_id, id AS package_id FROM packages WHERE home_space_id IS NOT NULL
    UNION SELECT space_id, package_id FROM space_packages
  ) placed GROUP BY space_id`;

export async function runFoldPackageShares(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<PackageSharesFold> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const result: PackageSharesFold = {
    inserted: 0,
    sharedByCopied: 0,
    skipped: [],
    orphans: [],
    emptied: 0,
    placements: [],
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      const counts = async (query: SQL) =>
        new Map(
          toRows<{ space_id: string; n: number }>(await tx.execute(query)).map((r) => [
            r.space_id,
            r.n,
          ]),
        );

      const [total] = toRows<{ shares: number; to_fold: number }>(
        await tx.execute(sql`SELECT
            (SELECT count(*)::int FROM package_shares) AS shares,
            (SELECT count(*)::int FROM ${FOLDABLE} WHERE NOT EXISTS (
              SELECT 1 FROM space_packages sp
              WHERE sp.package_id = ps.package_id AND sp.space_id = ps.space_id)) AS to_fold`),
      );
      out(`package_shares: ${total!.shares}, to fold: ${total!.to_fold}`);
      // Folded already (or never shared): nothing left to tell an orphan from a placement.
      if (total!.shares === 0) {
        if (!apply) throw new DryRunRollback();
        return;
      }

      const foreign = toRows<{ package_id: string; space_id: string }>(
        await tx.execute(sql`SELECT ps.package_id, ps.space_id
          FROM package_shares ps
          JOIN spaces s ON s.id = ps.space_id
          JOIN packages p ON p.id = ps.package_id
          WHERE p.org_id IS DISTINCT FROM s.org_id
          ORDER BY ps.package_id, ps.space_id`),
      );
      for (const row of foreign) {
        out(`  skipped ${row.package_id} → ${row.space_id}: foreign space`);
        result.skipped.push({ packageId: row.package_id, spaceId: row.space_id });
      }

      const before = await counts(PLACEMENTS_BEFORE);

      const orphans = toRows<{
        package_id: string;
        space_id: string;
        enabled: boolean;
        cross_org: boolean;
      }>(
        await tx.execute(sql`SELECT sp.package_id, sp.space_id, sp.enabled,
            s.org_id IS DISTINCT FROM p.org_id AS cross_org
          FROM ${ORPHANS} ORDER BY sp.package_id, sp.space_id`),
      );
      for (const row of orphans) {
        out(
          `  orphan ${row.package_id} → ${row.space_id}: enabled=${row.enabled}${row.cross_org ? ", foreign space" : ""} — deleted`,
        );
        result.orphans.push({
          packageId: row.package_id,
          spaceId: row.space_id,
          enabled: row.enabled,
          crossOrg: row.cross_org,
        });
      }
      await tx.execute(sql`DELETE FROM space_packages d USING (
          SELECT sp.space_id, sp.package_id FROM ${ORPHANS}) o
        WHERE d.space_id = o.space_id AND d.package_id = o.package_id`);

      const inserted = toRows<{ package_id: string }>(
        await tx.execute(sql`INSERT INTO space_packages (space_id, package_id, enabled, shared_by)
          SELECT ps.space_id, ps.package_id, false, ps.shared_by FROM ${FOLDABLE}
          ORDER BY ps.space_id, ps.package_id
          ON CONFLICT DO NOTHING
          RETURNING package_id`),
      );
      result.inserted = inserted.length;

      const copied = toRows<{ package_id: string }>(
        await tx.execute(sql`UPDATE space_packages sp SET shared_by = ps.shared_by
          FROM package_shares ps
          WHERE ps.package_id = sp.package_id AND ps.space_id = sp.space_id
            AND sp.shared_by IS NULL AND ps.shared_by IS NOT NULL
          RETURNING sp.package_id`),
      );
      result.sharedByCopied = copied.length;
      out(
        `inserted: ${result.inserted}, shared_by copied: ${result.sharedByCopied}, skipped: ${result.skipped.length}, orphans deleted: ${result.orphans.length}`,
      );

      const after = await counts(PLACEMENTS_AFTER);
      const spaceIds = [...new Set([...before.keys(), ...after.keys()])].sort();
      out("placements per space (before → after):");
      for (const spaceId of spaceIds) {
        const row = { spaceId, before: before.get(spaceId) ?? 0, after: after.get(spaceId) ?? 0 };
        out(`  ${spaceId}: ${row.before} → ${row.after}`);
        result.placements.push(row);
      }
      const differing = result.placements.filter((row) => row.before !== row.after);
      if (differing.length > 0) {
        throw new Error(
          `placements differ in ${differing.length} space(s): ${differing.map((row) => row.spaceId).join(", ")}`,
        );
      }

      // Emptied once folded, as `0044` empties `shared_space_ids`: the boot guard refuses while
      // the table holds a row, and no code writes it any more.
      const emptied = toRows<{ package_id: string }>(
        await tx.execute(sql`DELETE FROM package_shares RETURNING package_id`),
      );
      result.emptied = emptied.length;
      out(`package_shares emptied: ${result.emptied}`);
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0048: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0048: APPLIED — committed.");
  return result;
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0048 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runFoldPackageShares({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0048: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
