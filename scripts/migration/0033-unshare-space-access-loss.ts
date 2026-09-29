#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0033 — unshare the connections of owners who lost their space before the connection-sets
 * deploy.
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0033-unshare-space-access-loss.ts [--apply]
 *
 * Run FIRST in the deploy window, from the release checkout: platform stopped, `--apply`, then
 * `0032-connection-sets.sql`, then the deploy (`0077` applies at boot), then reopen. Before `0032`
 * because its freeze turns a colleague's still-shared connection into a member pin: run after it,
 * this would unshare connections just frozen, and those members would fail on pins they never
 * set. Safe on the pre-`0077` schema: it reads and writes only `integration_connections`
 * (`id`, `user_id`, `space_id`, `shared_with_org`, `updated_at`), `spaces`, `org_members`,
 * `space_members` and `space_roles`, none of which `0077` changes.
 *
 * The release unshares a connection the moment its owner loses access to its space; this applies
 * the same unshare to owners who lost it before the deploy — whether they left the organization
 * or, still in it, no longer reach the space (removed from it, demoted, the space closed) — with
 * the service's own predicate (`unshareConnectionsOfOwnersWithoutAccess`, `resolveSpaceRole`; no
 * org membership counts as no access), every organization in one transaction. An admin pin or org
 * default naming an unshared connection is left as it is and fails its runs with
 * `pinned_connection_unavailable`, as after a live access loss, until an admin changes it.
 *
 * Dry run by default (rolled back); `--apply` commits. Idempotent: a second run unshares nothing.
 * Rollback: the owner re-shares, should they regain the space; the ids are printed.
 */

import { parseArgs } from "node:util";
import { closeDb, db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { unshareConnectionsOfOwnersWithoutAccess } from "../../apps/api/src/services/space-members.ts";

class DryRunRollback extends Error {}

/** @returns the ids unshared (or that would be, on a dry run). */
export async function runUnshareSpaceAccessLoss(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<string[]> {
  const { apply, out } = options;
  const unshared: string[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '120s'");
      const orgs = await tx.select({ id: organizations.id }).from(organizations);
      for (const org of orgs) {
        const ids = await unshareConnectionsOfOwnersWithoutAccess(tx, { orgId: org.id });
        if (ids.length === 0) continue;
        out(`  org ${org.id}: ${ids.length} — ${ids.join(", ")}`);
        unshared.push(...ids);
      }
      out(`connections unshared: ${unshared.length}`);
      if (!apply) throw new DryRunRollback();
    });
    out("0033: APPLIED — committed.");
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0033: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  }
  return unshared;
}

if (import.meta.main) {
  let code = 1;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0033 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runUnshareSpaceAccessLoss({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0033: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb();
  }
  process.exit(code);
}
