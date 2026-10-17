#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0046 — package shares folded into `space_packages` (#2045):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0046-fold-package-shares.ts [--apply]
 *
 * Drizzle `0099` gives `space_packages` a `shared_by` column and leaves `package_shares` in place,
 * read only by this script and the boot guard `assertPackageSharesFolded`. Each share becomes the
 * `space_packages` row of its (space, package), `enabled = false` and `shared_by` copied,
 * `ON CONFLICT DO NOTHING`: a space that had already activated the package keeps its row, which
 * then gains the `shared_by` it lacks. A share whose space belongs to another organization than
 * the package is skipped and printed. Per space, the placements before (home ∨ share ∨ row) and
 * after (home ∨ row) are printed and must be equal, or the transaction rolls back. Then the table
 * is emptied, skipped shares included: nothing reads it, and a skipped share placed nothing under
 * the org boundary. Run after the
 * migrations have applied `0099` and BEFORE the app starts, `pg_dump` first: an app serving `0099`
 * before it runs no longer sees the packages shared but never activated, and the platform refuses
 * to boot until it has. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with neither
 * (`lib/database-target.ts`). One transaction; dry run by default (rolled back), `--apply` commits.
 * A second `--apply` finds the table empty and writes nothing.
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

export interface PackageSharesFold {
  inserted: number;
  /** Existing rows whose `shared_by` was copied from their share. */
  sharedByCopied: number;
  /** Shares naming a space of another organization than the package's — deleted, not folded. */
  skipped: SkippedPackageShare[];
  /** `package_shares` rows deleted once folded. */
  emptied: number;
  placements: SpacePlacements[];
}

/** Every share whose space and package belong to the same organization. */
const FOLDABLE = sql`package_shares ps
  JOIN spaces s ON s.id = ps.space_id
  JOIN packages p ON p.id = ps.package_id AND p.org_id = s.org_id`;

const PLACEMENTS_BEFORE = sql`SELECT space_id, count(DISTINCT package_id)::int AS n FROM (
    SELECT home_space_id AS space_id, id AS package_id FROM packages WHERE home_space_id IS NOT NULL
    UNION SELECT ps.space_id, ps.package_id FROM ${FOLDABLE}
    UNION SELECT space_id, package_id FROM space_packages
  ) placed GROUP BY space_id`;

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
        `inserted: ${result.inserted}, shared_by copied: ${result.sharedByCopied}, skipped: ${result.skipped.length}`,
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
    out("0046: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0046: APPLIED — committed.");
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
    out(`0046 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runFoldPackageShares({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0046: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
