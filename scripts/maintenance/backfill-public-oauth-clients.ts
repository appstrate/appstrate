// SPDX-License-Identifier: Apache-2.0

/**
 * Record, once, what `integration_oauth_clients` rows written before
 * `token_endpoint_auth_method` existed can only say by being decrypted.
 *
 *   bun scripts/maintenance/backfill-public-oauth-clients.ts [--dry-run]
 *
 * Before that column, "public client" was inferred from an empty secret — an
 * inference asserted in comments and enforced nowhere, which sent
 * `client_secret=` (present but empty) to providers that reject it. The column
 * now stores the admin's declaration, but legacy rows still encrypt an EMPTY
 * secret rather than declaring `none`.
 *
 * Postgres cannot do this itself: `client_secret_encrypted` is ciphertext, so
 * a SQL migration cannot tell an empty secret from a real one. Hence a script,
 * run with the platform's `CONNECTION_ENCRYPTION_KEY` available.
 *
 * For every row with no declared method:
 *   - empty secret  → `token_endpoint_auth_method='none'` + ciphertext cleared
 *     (a public client stores no ciphertext at all)
 *   - real secret   → left untouched: `NULL` correctly means "the manifest
 *     decides", which is what a confidential client wants.
 *
 * A row whose ciphertext does not open is REPORTED and skipped, never guessed
 * at, and makes this script exit 1 — writing `none` there would silently turn a
 * confidential client into a public one.
 *
 * Idempotent — a second run finds nothing to do. This is REMEDIAL, not
 * cosmetic: the resolvers no longer read a legacy row's meaning out of its
 * ciphertext, so connecting or refreshing such a client fails with an error
 * naming this command until it has run.
 *
 * The biconditional CHECK (`ioc_public_iff_no_secret`, public IFF no
 * ciphertext) does NOT wait on this script and is already in place: a legacy
 * public row is `NULL` + a ciphertext of an empty secret, which the constraint
 * cannot see through and therefore already accepts — and, by the same token,
 * can never eliminate. Only this script can.
 *
 * All logic lives in the service so it resolves its deps and stays testable —
 * same split as `scripts/maintenance/storage-orphans.ts`.
 */

import { backfillPublicOAuthClients } from "../../apps/api/src/services/backfill-public-oauth-clients.ts";

const dryRun = process.argv.includes("--dry-run");
const report = await backfillPublicOAuthClients({ dryRun });

for (const row of report.undecryptable) {
  process.stderr.write(
    `  ! ${row.integrationId}#${row.authKey} (${row.id}): decrypt failed — skipped (${row.error})\n`,
  );
}

process.stdout.write(
  `${report.dryRun ? "[dry-run] " : ""}undeclared rows: ${report.scanned} → ` +
    `${report.declaredPublic} public (declared 'none'), ` +
    `${report.leftConfidential} confidential (left undeclared — the manifest decides), ` +
    `${report.undecryptable.length} skipped\n`,
);

if (report.undecryptable.length > 0) {
  process.stderr.write(
    `\n${report.undecryptable.length} row(s) could not be decrypted and still carry no ` +
      `declaration. Re-register those clients, or restore the encryption key they were written ` +
      `with, then run this again.\n`,
  );
}

process.exit(report.undecryptable.length > 0 ? 1 : 0);
