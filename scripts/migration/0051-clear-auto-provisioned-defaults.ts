#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0051 — the default flag an auto-provisioned (DCR) OAuth client still carries, cleared:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0051-clear-auto-provisioned-defaults.ts [--apply]
 *
 * An auto-provisioned client is never a default: connect finds it by its issuer, and no classic
 * flow or default picker reads it. A row registered while DCR clients were still flagged keeps
 * `is_default = true`, and that flag holds the partial unique slot of its tier
 * (`idx_ioc_one_default` / `idx_ioc_one_org_default`), so the platform's default bookkeeping
 * (`hasTierDefault`) would read the tier as having a default no picker serves.
 *
 * Run in the beta.69 window, before the release serves traffic. Dry run by default: lists the rows
 * (org, space or org tier, integration, auth, client id, issuer), writes nothing. With `--apply`,
 * `is_default = false` and `updated_at` bumped on exactly those rows, in one transaction; it exits
 * 1 unless none is left after. Idempotent: a second run finds nothing. Counts UNMEASURED: rehearse
 * on a restored dump and record them in the README's Log. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`).
 */

import { parseArgs } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { integrationOauthClients } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";

/** Exactly the rows this script rewrites, so a second run matches none. */
const FLAGGED_AUTO_CLIENT = and(
  eq(integrationOauthClients.autoProvisioned, true),
  eq(integrationOauthClients.isDefault, true),
);

export async function runClearAutoProvisionedDefaults(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const flagged = () =>
    db
      .select({
        id: integrationOauthClients.id,
        orgId: integrationOauthClients.orgId,
        spaceId: integrationOauthClients.spaceId,
        integrationId: integrationOauthClients.integrationId,
        authKey: integrationOauthClients.authKey,
        clientId: integrationOauthClients.clientId,
        issuer: integrationOauthClients.issuer,
      })
      .from(integrationOauthClients)
      .where(FLAGGED_AUTO_CLIENT)
      .orderBy(integrationOauthClients.orgId, integrationOauthClients.createdAt);
  const rows = await flagged();
  for (const row of rows) {
    out(
      `  ${row.id}  org ${row.orgId}  ${row.spaceId ? `space ${row.spaceId}` : "org tier"}  ${row.integrationId} auth ${row.authKey}  client ${row.clientId}  issuer ${row.issuer ?? "-"}`,
    );
  }
  out(`auto-provisioned clients flagged default: ${rows.length}`);
  if (!apply) {
    out("0051: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const cleared = await db.transaction(async (tx) => {
    await tx.execute("SET LOCAL lock_timeout = '5s'");
    await tx.execute("SET LOCAL statement_timeout = '60s'");
    return tx
      .update(integrationOauthClients)
      .set({ isDefault: false, updatedAt: sql`now()` })
      .where(FLAGGED_AUTO_CLIENT)
      .returning({ id: integrationOauthClients.id });
  });
  out(`cleared: ${cleared.length}`);
  const left = (await flagged()).length;
  out(`left: ${left}`);
  if (left !== 0)
    throw new Error("auto-provisioned clients flagged default are left after --apply");
  out("0051: APPLIED — committed.");
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
    out(`0051 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runClearAutoProvisionedDefaults({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0051: FAILED — ${getErrorMessage(error)}. The update is one transaction; a re-run with --apply finishes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
