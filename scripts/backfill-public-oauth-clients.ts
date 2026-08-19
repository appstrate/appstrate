// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Record, once, what `integration_oauth_clients` rows written before
 * `token_endpoint_auth_method` existed can only say by being decrypted.
 *
 * Before that column, "public client" was inferred from an empty secret — an
 * inference asserted in comments and enforced nowhere, which sent
 * `client_secret=` (present but empty) to providers that reject it. The column
 * now stores the admin's declaration, but legacy rows still encrypt an EMPTY
 * secret rather than declaring `none`, so the resolver keeps a legacy branch
 * that decrypts to find out.
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
 * Idempotent — a second run finds nothing to do. Once every deployment has run
 * it, the resolver's legacy branch and `projectClientWithSecret`'s legacy
 * fallback can be deleted, and the biconditional CHECK constraint (public IFF
 * no ciphertext) can land.
 *
 *   bun scripts/backfill-public-oauth-clients.ts [--dry-run]
 */

import { db } from "@appstrate/db/client";
import { integrationOauthClients } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { eq, isNull } from "drizzle-orm";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: integrationOauthClients.id,
      integrationId: integrationOauthClients.integrationId,
      authKey: integrationOauthClients.authKey,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
    })
    .from(integrationOauthClients)
    .where(isNull(integrationOauthClients.tokenEndpointAuthMethod));

  let publicClients = 0;
  let confidential = 0;
  let undecryptable = 0;

  for (const row of rows) {
    // Already stored the new way — nothing to decide.
    if (row.clientSecretEncrypted === "") {
      publicClients++;
      if (!dryRun) {
        await db
          .update(integrationOauthClients)
          .set({ tokenEndpointAuthMethod: "none" })
          .where(eq(integrationOauthClients.id, row.id));
      }
      continue;
    }

    let secret: string;
    try {
      secret =
        decryptCredentials<{ client_secret?: string }>(row.clientSecretEncrypted).client_secret ??
        "";
    } catch (err) {
      // A row whose ciphertext no longer opens (key rotated without re-encrypt,
      // corruption) is REPORTED and skipped, never guessed at: writing `none`
      // here would silently turn a confidential client into a public one.
      undecryptable++;
      console.error(
        `  ! ${row.integrationId}#${row.authKey} (${row.id}): decrypt failed — skipped (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      continue;
    }

    if (secret.length > 0) {
      confidential++;
      continue;
    }

    publicClients++;
    if (!dryRun) {
      await db
        .update(integrationOauthClients)
        .set({ tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" })
        .where(eq(integrationOauthClients.id, row.id));
    }
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}undeclared rows: ${rows.length} → ` +
      `${publicClients} public (declared 'none'), ` +
      `${confidential} confidential (left undeclared — the manifest decides), ` +
      `${undecryptable} skipped`,
  );
  if (undecryptable > 0) {
    console.error(
      `\n${undecryptable} row(s) could not be decrypted and still carry no declaration. ` +
        `Re-register those clients, or restore the encryption key they were written with, ` +
        `then run this again.`,
    );
    process.exit(1);
  }
}

await main();
