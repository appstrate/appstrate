#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0046 — the stored `credential-proxy:call` becomes `credential-proxy:call-run` and `call-own`:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0046-rename-credential-proxy-call-scope.ts [--apply]
 *
 * The permission of a credential-proxy call made for a run is `credential-proxy:call-run`, and a
 * stored permission string the platform does not know grants nothing. Two columns store permission
 * strings: `api_keys.scopes` and `space_roles.permissions`. In each row holding
 * `credential-proxy:call`, that element becomes `credential-proxy:call-run` where it stands
 * and `credential-proxy:call-own` is appended, the rest kept. Revoked and expired keys are
 * rewritten like the others. The OIDC scope columns are left alone: the OIDC vocabulary does not list the
 * permission, so no client, token or consent stores it. Audit payloads are history and stay as
 * written.
 *
 * Run it in the deploy window, after the migrate service and BEFORE the release serves a request,
 * `pg_dump` first; on the running previous release, the dry run only.
 *
 * Refuses an empty `DATABASE_URL` (the client would open `./data/pglite`). One transaction; dry
 * run by default (rolled back), `--apply` commits. It prints counts and row ids, never a key hash.
 * Idempotent: the rows rewritten are the rows holding the old name, which the write removes, so a
 * second run finds none. Rollback: `scripts/migration/README.md`, script `0046`.
 */

import { parseArgs } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { apiKeys, spaceRoles } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

const OLD = "credential-proxy:call";
const RUN = "credential-proxy:call-run";
const OWN = "credential-proxy:call-own";

/** The rows whose `column` holds the old name: exactly what {@link renamed} removes. */
const holdsOld = (column: AnyPgColumn): SQL => sql`${OLD} = ANY(${column})`;

const renamed = (column: AnyPgColumn): SQL<string[]> =>
  sql<string[]>`array_append(array_replace(${column}, ${OLD}, ${RUN}), ${OWN})`;

interface RenamedRows {
  apiKeyIds: string[];
  roles: Array<{ id: string; orgId: string; key: string }>;
}

export async function runRenameCredentialProxyCallScope(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<RenamedRows> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const result: RenamedRows = { apiKeyIds: [], roles: [] };
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '120s'");

      const keys = await tx
        .update(apiKeys)
        .set({ scopes: renamed(apiKeys.scopes) })
        .where(holdsOld(apiKeys.scopes))
        .returning({ id: apiKeys.id });
      result.apiKeyIds = keys.map((row) => row.id).sort();
      out(`api_keys.scopes holding ${OLD}: ${result.apiKeyIds.length}`);
      for (const id of result.apiKeyIds) out(`  key ${id}`);

      const roles = await tx
        .update(spaceRoles)
        .set({ permissions: renamed(spaceRoles.permissions) })
        .where(holdsOld(spaceRoles.permissions))
        .returning({ id: spaceRoles.id, orgId: spaceRoles.orgId, key: spaceRoles.key });
      result.roles = roles.sort((a, b) => a.id.localeCompare(b.id));
      out(`space_roles.permissions holding ${OLD}: ${result.roles.length}`);
      for (const role of result.roles)
        out(`  role ${role.id} (org ${role.orgId}, key ${role.key})`);

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
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is empty — refusing the embedded ./data/pglite; load the .env");
    }
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0046 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runRenameCredentialProxyCallScope({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0046: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
