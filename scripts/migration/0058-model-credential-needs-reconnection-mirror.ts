#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0058 — `model_provider_credentials.needs_reconnection` brought in line with the blob's flag:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0058-model-credential-needs-reconnection-mirror.ts [--apply]
 *
 * The column is the one authority on whether a credential is dead (the background refresh sweep
 * skips a flagged row without decrypting it). It was added defaulting to false, so a credential
 * whose blob carried the flag before the column existed still reads false: the sweep would claim
 * it and its job would end on a 410. This copies that blob flag into the column.
 *
 * Run in the release window that ships the column. Dry run by default: lists the rows to flag,
 * writes nothing. With `--apply`, `needs_reconnection = true` on exactly those rows, in one
 * transaction; it exits 1 unless none is left after. A blob that cannot be decrypted is listed and
 * left alone. Idempotent. Counts UNMEASURED: rehearse on a restored dump
 * and record them in the README's Log. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with
 * neither (`lib/database-target.ts`).
 */

import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials as t } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";

export async function runModelCredentialNeedsReconnectionMirror(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  const { db } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());

  /** The unflagged rows whose blob says flagged, and the ones whose blob cannot be read. */
  const scan = async () => {
    const rows = await db
      .select({ id: t.id, providerId: t.providerId, credentialsEncrypted: t.credentialsEncrypted })
      .from(t)
      .where(eq(t.needsReconnection, false));
    const drifted: { id: string; providerId: string }[] = [];
    let unreadable = 0;
    for (const row of rows) {
      try {
        const blob = decryptCredentials<{ needsReconnection?: boolean }>(row.credentialsEncrypted);
        if (blob.needsReconnection === true) drifted.push(row);
      } catch (error) {
        unreadable++;
        out(
          `  unreadable blob, left alone: ${row.id}  ${row.providerId}  ${getErrorMessage(error)}`,
        );
      }
    }
    return { scanned: rows.length, drifted, unreadable };
  };

  const before = await scan();
  for (const row of before.drifted) out(`  ${row.id}  ${row.providerId}`);
  out(`unflagged rows scanned: ${before.scanned}`);
  out(`blob flagged, column not: ${before.drifted.length}`);
  out(`unreadable: ${before.unreadable}`);
  if (!apply) {
    out("0058: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const ids = before.drifted.map((row) => row.id);
  const flagged =
    ids.length === 0
      ? []
      : await db.transaction(async (tx) => {
          await tx.execute("SET LOCAL lock_timeout = '5s'");
          await tx.execute("SET LOCAL statement_timeout = '60s'");
          return tx
            .update(t)
            .set({ needsReconnection: true })
            .where(and(inArray(t.id, ids), eq(t.needsReconnection, false)))
            .returning({ id: t.id });
        });
  out(`flagged: ${flagged.length}`);
  const left = (await scan()).drifted.length;
  out(`left: ${left}`);
  if (left !== 0) throw new Error("credentials whose blob is flagged are left after --apply");
  out("0058: APPLIED — committed.");
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
    out(`0058 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runModelCredentialNeedsReconnectionMirror({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0058: FAILED — ${getErrorMessage(error)}. The update is one transaction; a re-run with --apply finishes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
