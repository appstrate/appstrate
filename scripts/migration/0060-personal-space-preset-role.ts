#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0060 — the personal-space default preset role leaves `org_settings` for its own column:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0060-personal-space-preset-role.ts [--apply]
 *
 * Run after drizzle `0118` has applied and BEFORE the app starts (`pg_dump` first): the platform
 * refuses to boot until it has run (the `0060` entry of `PENDING_DATA_SCRIPTS`,
 * `apps/api/src/lib/boot-guards/pending-data-scripts.ts`). Dry run by default (rolled back);
 * `--apply` commits; a second `--apply` writes nothing. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`).
 *
 * In one transaction, for each organization whose `org_settings` still holds `personal_space_role`:
 * a preset value is copied into `organizations.personal_space_preset_role` (unless the row already
 * names a custom role, which wins), then the key is removed. `updated_at` is left alone.
 */

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";

class DryRunRollback extends Error {}

export interface PersonalSpacePresetRole {
  /** Organizations whose key was moved, with the column's new value (`null`: a custom role is named, which wins). */
  moved: { orgId: string; presetRole: string | null }[];
}

export async function runPersonalSpacePresetRole(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<PersonalSpacePresetRole> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());

  const result: PersonalSpacePresetRole = { moved: [] };
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");

      const rows = toRows<{ id: string; preset_role: string | null }>(
        await tx.execute(sql`UPDATE organizations SET
            personal_space_preset_role = CASE
              WHEN personal_space_role_id IS NULL THEN org_settings ->> 'personal_space_role'
              ELSE personal_space_preset_role
            END,
            org_settings = org_settings - 'personal_space_role'
          WHERE org_settings ? 'personal_space_role'
          RETURNING id, personal_space_preset_role AS preset_role`),
      );
      for (const row of rows) {
        out(`  ${row.id}: personal_space_preset_role = ${row.preset_role ?? "NULL"}`);
        result.moved.push({ orgId: row.id, presetRole: row.preset_role });
      }
      out(`organizations moved: ${result.moved.length}`);
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0060: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0060: APPLIED — committed.");
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
    out(`0060 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runPersonalSpacePresetRole({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0060: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
