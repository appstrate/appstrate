#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0040 — stored `token_usage` brought to the token-usage rule (#1846):
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0040-token-usage-shape.ts [--apply]
 *
 * A run's `token_usage` is published as the strict `TokenUsage` component, and the run read paths
 * return the column verbatim. A row `parseTokenUsage` keeps only in part is listed and, with
 * `--apply`, rewritten to what it keeps: undeclared keys and malformed `tiers` bands dropped, the
 * counters untouched. A row malformed as a whole (not an object, or a counter that is not a
 * non-negative integer — a fraction the earlier rule accepted included) is listed and left as it
 * is, for an operator to decide. A row written after the scan is left alone: the update matches the
 * value read. Dry run by default (rolled back). Exit 1 while a malformed row remains, in both modes.
 */

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { organizations, runs } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { parseTokenUsage } from "@appstrate/afps-shared/token-usage";

class DryRunRollback extends Error {}

export async function runTokenUsageShape(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<0 | 1> {
  const { apply, out } = options;
  // Imported here, not at the top: `@appstrate/db/client` opens its database on import, and the
  // entry point refuses the embedded one before that.
  const { db } = await import("@appstrate/db/client");
  let malformed = 0;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '120s'");
      out(`0040 — ${apply ? "APPLY" : "DRY RUN"}`);
      const rows = await tx
        .select({
          org: organizations.slug,
          id: runs.id,
          stored: sql<string>`${runs.tokenUsage}::text`,
        })
        .from(runs)
        .innerJoin(organizations, eq(organizations.id, runs.orgId))
        .where(isNotNull(runs.tokenUsage))
        .orderBy(asc(organizations.slug), asc(runs.id));

      let rewritten = 0;
      for (const row of rows) {
        const raw: unknown = JSON.parse(row.stored);
        const { usage } = parseTokenUsage(raw);
        if (usage === null) {
          malformed += 1;
          out(`  MALFORMED ${row.org} ${row.id}: ${row.stored}`);
          continue;
        }
        if (Bun.deepEquals(usage, raw)) continue;
        const [updated] = await tx
          .update(runs)
          .set({ tokenUsage: usage })
          .where(and(eq(runs.id, row.id), sql`${runs.tokenUsage} = ${row.stored}::jsonb`))
          .returning({ id: runs.id });
        if (!updated) continue;
        rewritten += 1;
        out(`  rewrite   ${row.org} ${row.id}: ${row.stored} → ${JSON.stringify(usage)}`);
      }

      out(
        `${rows.length} run(s) with a token_usage, ${rewritten} rewritten, ` +
          `${malformed} malformed left as is`,
      );
      if (!apply) throw new DryRunRollback();
    });
    out("0040: APPLIED — committed.");
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0040: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  }
  return malformed > 0 ? 1 : 0;
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const out = (line: string) => process.stdout.write(`${line}\n`);
  // An empty DATABASE_URL makes `@appstrate/db/client` open ./data/pglite instead.
  if (!process.env.DATABASE_URL) {
    out("DATABASE_URL is required — the platform database to rewrite");
    process.exit(2);
  }
  const { closeDb } = await import("@appstrate/db/client");
  let code = 1;
  try {
    code = await runTokenUsageShape({ apply, out });
  } catch (error) {
    out(`0040: FAILED, nothing committed — ${getErrorMessage(error)}`);
  } finally {
    await closeDb();
  }
  process.exit(code);
}
