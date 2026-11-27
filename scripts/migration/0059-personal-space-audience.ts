#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0059 — personal spaces take the organization's offer only (#2428):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0059-personal-space-audience.ts [--apply]
 *
 * Run after drizzle `0118` has applied and BEFORE the app starts (`pg_dump` first): the platform
 * refuses to boot while a personal space still holds a package the organization never offered, or a
 * `package_shared` notification remains (the `0059` entry of `PENDING_DATA_SCRIPTS`,
 * `apps/api/src/lib/boot-guards/pending-data-scripts.ts`). Dry run by default (rolled back);
 * `--apply` commits; a second `--apply` writes nothing. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`).
 *
 * A personal space (`spaces.owner_user_id IS NOT NULL`) runs what it creates, what the organization
 * offers (`org_package_offers`, either mode) and what the deployment runs by default. The rows
 * below are an ORGANIZATION package's `space_packages` rows in a personal space outside the
 * package's home, with no offer to that organization. System packages (`org_id IS NULL`) are left
 * alone. One transaction, in this order:
 *
 *  (a) An ENABLED row of an integration: the owner switched on an integration the organization
 *      never offered. The user's access is kept by offering it: one `org_package_offers` row per
 *      (organization, package), `mode = 'available'`, `offered_by` NULL (no admin decided it),
 *      `ON CONFLICT DO NOTHING`, audited `package.offered_to_org` by the `system` actor. The row
 *      stays as it is.
 *  (b) Every other row, whatever its type or `enabled`: deleted as `withdrawPlacement` deletes
 *      (`services/package-placement.ts`). Each enabled schedule of the package in that space is
 *      disabled first (`disabled_reason = 'package_removed'`, `next_run_at` cleared, `updated_at`
 *      advanced as `nextScheduleVersion` does), then the row is deleted and audited
 *      `package.unshared` by the `system` actor. The script runs with the platform stopped: no
 *      queue job is removed here, and `initScheduleWorker` (`services/scheduler.ts`) syncs only
 *      `enabled` schedules into the queue at boot, so a disabled schedule is not re-armed; a job
 *      left in Redis removes itself at its next fire (`disableScheduleAtFire`).
 *  (c) Notifications of the retired kind `package_shared` are deleted, then
 *      `ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_valid` takes the half of
 *      drizzle `0118`'s `NOT VALID` CHECK that covers existing rows. Validating an already valid
 *      constraint is a no-op, so a second run holds.
 *
 * Not seen from the database: an integration named by `SYSTEM_INTEGRATIONS` is active by the
 * deployment's default, which the door lets a personal space keep but this script cannot read. Its
 * row, with no offer, is treated as any other: kept by an offer when enabled, deleted when not.
 */

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";

class DryRunRollback extends Error {}

export interface OfferedIntegration {
  orgId: string;
  packageId: string;
}

export interface DeletedPlacement {
  packageId: string;
  spaceId: string;
  enabled: boolean;
  schedulesDisabled: number;
}

export interface PersonalSpaceAudience {
  /** Offers created for integrations a personal space had switched on. */
  offers: OfferedIntegration[];
  /** Rows deleted, with the schedules each took down. */
  deleted: DeletedPlacement[];
  schedulesDisabled: number;
  notificationsDeleted: number;
}

/** An organization package's row in a personal space, outside its home, with no offer to that organization. */
const PERSONAL = sql`space_packages sp
  JOIN spaces s ON s.id = sp.space_id AND s.owner_user_id IS NOT NULL
  JOIN packages p ON p.id = sp.package_id
  WHERE p.org_id IS NOT NULL
    AND p.org_id = s.org_id
    AND sp.space_id IS DISTINCT FROM p.home_space_id
    AND NOT EXISTS (SELECT 1 FROM org_package_offers o
      WHERE o.org_id = s.org_id AND o.package_id = p.id)`;

export async function runPersonalSpaceAudience(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<PersonalSpaceAudience> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const result: PersonalSpaceAudience = {
    offers: [],
    deleted: [],
    schedulesDisabled: 0,
    notificationsDeleted: 0,
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");

      // (a) Enabled integrations the organization never offered: kept by an offer.
      const wanted = toRows<{ org_id: string; package_id: string }>(
        await tx.execute(sql`SELECT DISTINCT s.org_id, sp.package_id
          FROM ${PERSONAL} AND sp.enabled = true AND p.type = 'integration'
          ORDER BY s.org_id, sp.package_id`),
      );
      for (const row of wanted) {
        const created = toRows<{ package_id: string }>(
          await tx.execute(sql`INSERT INTO org_package_offers (org_id, package_id, mode, offered_by)
            VALUES (${row.org_id}, ${row.package_id}, 'available', NULL)
            ON CONFLICT DO NOTHING
            RETURNING package_id`),
        );
        if (created.length === 0) continue;
        await tx.execute(sql`INSERT INTO audit_events
            (org_id, actor_type, action, resource_type, resource_id, after)
          VALUES (${row.org_id}, 'system', 'package.offered_to_org', 'package', ${row.package_id},
            jsonb_build_object('orgId', ${row.org_id}::text, 'mode', 'available',
              'reason', 'personal_space_audience'))`);
        out(`  offered ${row.package_id} to ${row.org_id}: available`);
        result.offers.push({ orgId: row.org_id, packageId: row.package_id });
      }

      // (b) Everything else in a personal space with no offer: withdrawn.
      const rows = toRows<{
        org_id: string;
        space_id: string;
        package_id: string;
        enabled: boolean;
      }>(
        await tx.execute(sql`SELECT s.org_id, sp.space_id, sp.package_id, sp.enabled
          FROM ${PERSONAL} ORDER BY sp.package_id, sp.space_id`),
      );
      for (const row of rows) {
        const disabled = toRows<{ id: string }>(
          await tx.execute(sql`UPDATE package_schedules SET enabled = false,
              disabled_reason = 'package_removed', next_run_at = NULL,
              updated_at = greatest(clock_timestamp(),
                date_trunc('milliseconds', updated_at) + interval '1 millisecond')
            WHERE package_id = ${row.package_id} AND space_id = ${row.space_id} AND enabled = true
            RETURNING id`),
        );
        await tx.execute(sql`DELETE FROM space_packages
          WHERE space_id = ${row.space_id} AND package_id = ${row.package_id}`);
        await tx.execute(sql`INSERT INTO audit_events
            (org_id, space_id, actor_type, action, resource_type, resource_id, after)
          VALUES (${row.org_id}, ${row.space_id}, 'system', 'package.unshared', 'package',
            ${row.package_id},
            jsonb_build_object('spaceId', ${row.space_id}::text, 'reason', 'personal_space'))`);
        out(
          `  deleted ${row.package_id} → ${row.space_id}: enabled=${row.enabled}, schedules disabled: ${disabled.length}`,
        );
        result.deleted.push({
          packageId: row.package_id,
          spaceId: row.space_id,
          enabled: row.enabled,
          schedulesDisabled: disabled.length,
        });
        result.schedulesDisabled += disabled.length;
      }

      // (c) The retired notification kind, then the half of the CHECK 0118 left unvalidated.
      const notifications = toRows<{ id: string }>(
        await tx.execute(sql`DELETE FROM notifications WHERE type = 'package_shared' RETURNING id`),
      );
      result.notificationsDeleted = notifications.length;
      await tx.execute("ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_valid");

      out(
        `offers created: ${result.offers.length}, rows deleted: ${result.deleted.length}, schedules disabled: ${result.schedulesDisabled}, notifications deleted: ${result.notificationsDeleted}`,
      );
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0059: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0059: APPLIED — committed.");
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
    out(`0059 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runPersonalSpaceAudience({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0059: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
