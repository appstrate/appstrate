// SPDX-License-Identifier: Apache-2.0

/**
 * Canonicalise legacy public OAuth clients — the reusable half of
 * `scripts/maintenance/backfill-public-oauth-clients.ts`.
 *
 * Before `integration_oauth_clients.token_endpoint_auth_method` existed,
 * "public client" was inferred from an empty secret — an inference asserted in
 * comments and enforced nowhere, which sent `client_secret=` (present but
 * empty) to providers that reject it. The column now stores the admin's
 * declaration, but legacy rows still encrypt an EMPTY secret rather than
 * declaring `none`.
 *
 * Postgres cannot do this itself: `client_secret_encrypted` is ciphertext, so a
 * SQL migration cannot tell an empty secret from a real one. Hence a service
 * driven by an operator script, run with the platform's
 * `CONNECTION_ENCRYPTION_KEY` available.
 *
 * For every row with no declared method:
 *   - empty secret  → `token_endpoint_auth_method='none'` + ciphertext cleared
 *     (a public client stores no ciphertext at all)
 *   - real secret   → left untouched: `NULL` correctly means "the manifest
 *     decides", which is what a confidential client wants.
 *   - undecryptable → REPORTED and skipped, never guessed at.
 *
 * Idempotent — a second run finds nothing to do. The resolvers no longer carry
 * a branch that reads a legacy row's meaning out of its ciphertext: connect and
 * refresh both REFUSE such a row and name this script as the remedy. So running
 * it is what makes those clients usable again, not merely tidier — and this is
 * the only thing that can, since Postgres cannot see through the ciphertext.
 *
 * This module decides and writes; it never prints. The caller owns the report
 * and the exit code — same split as `./storage-orphans.ts` and
 * `./audit-empty-integration-selections.ts`.
 */

import { db } from "@appstrate/db/client";
import { integrationOauthClients } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { eq, isNull } from "drizzle-orm";

/** The columns the decision needs, as read from `integration_oauth_clients`. */
export interface UndeclaredClientRow {
  id: string;
  integrationId: string;
  authKey: string;
  clientSecretEncrypted: string;
}

/**
 * What a row with no declared method turns out to be.
 *
 * `undecryptable` is a verdict of its own and NOT a public client: a row whose
 * ciphertext no longer opens (key rotated without re-encrypt, corruption) holds
 * a secret nobody can read, and writing `none` for it would silently turn a
 * confidential client into a public one.
 */
export type ClientVerdict =
  { verdict: "public" } | { verdict: "confidential" } | { verdict: "undecryptable"; error: string };

/** A row this run refused to decide, carried out to the operator verbatim. */
export interface UndecryptableClient {
  id: string;
  integrationId: string;
  authKey: string;
  error: string;
}

/** Outcome of one backfill pass. */
export interface BackfillReport {
  /** Whether this pass was allowed to write. */
  dryRun: boolean;
  /** Rows with no declared method, i.e. the candidates this pass examined. */
  scanned: number;
  /** Rows declared `none` (would be declared, under `dryRun`). */
  declaredPublic: number;
  /** Rows left undeclared because they hold a real secret. */
  leftConfidential: number;
  /** Rows whose ciphertext did not open — decided by nobody, changed by nothing. */
  undecryptable: UndecryptableClient[];
}

/**
 * Classify one undeclared row. Pure apart from the injected `decrypt`, so the
 * three-way decision — the part that must never guess — is testable without a
 * database.
 */
export function decideUndeclaredClient(
  row: Pick<UndeclaredClientRow, "clientSecretEncrypted">,
  decrypt: (ciphertext: string) => { client_secret?: string } = (ciphertext) =>
    decryptCredentials<{ client_secret?: string }>(ciphertext),
): ClientVerdict {
  // Already stored the new way — nothing to decrypt. Unreachable while the
  // `ioc_public_iff_no_secret` CHECK holds (it forbids an undeclared row from
  // carrying an empty ciphertext), and kept for a database that predates it.
  if (row.clientSecretEncrypted === "") return { verdict: "public" };

  let secret: string;
  try {
    secret = decrypt(row.clientSecretEncrypted).client_secret ?? "";
  } catch (err) {
    return { verdict: "undecryptable", error: err instanceof Error ? err.message : String(err) };
  }

  return secret.length > 0 ? { verdict: "confidential" } : { verdict: "public" };
}

/** Every row that has not declared its client-authentication method yet. */
export async function listUndeclaredClients(): Promise<UndeclaredClientRow[]> {
  return db
    .select({
      id: integrationOauthClients.id,
      integrationId: integrationOauthClients.integrationId,
      authKey: integrationOauthClients.authKey,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
    })
    .from(integrationOauthClients)
    .where(isNull(integrationOauthClients.tokenEndpointAuthMethod));
}

/**
 * Decide every undeclared row and, unless `dryRun`, record the decision.
 *
 * The write sets BOTH halves together because `ioc_public_iff_no_secret` makes
 * them one fact: a row declaring `none` while still holding a ciphertext is not
 * representable.
 *
 * An undecryptable row never reaches an UPDATE — it is collected into the
 * report so the caller can surface it and fail. The pass still completes: one
 * unreadable row must not hide the rows that could be canonicalised.
 */
export async function backfillPublicOAuthClients(
  opts: { dryRun?: boolean } = {},
): Promise<BackfillReport> {
  const dryRun = opts.dryRun === true;
  const rows = await listUndeclaredClients();

  const report: BackfillReport = {
    dryRun,
    scanned: rows.length,
    declaredPublic: 0,
    leftConfidential: 0,
    undecryptable: [],
  };

  for (const row of rows) {
    const decision = decideUndeclaredClient(row);

    if (decision.verdict === "undecryptable") {
      report.undecryptable.push({
        id: row.id,
        integrationId: row.integrationId,
        authKey: row.authKey,
        error: decision.error,
      });
      continue;
    }

    if (decision.verdict === "confidential") {
      report.leftConfidential += 1;
      continue;
    }

    report.declaredPublic += 1;
    if (!dryRun) {
      await db
        .update(integrationOauthClients)
        .set({ tokenEndpointAuthMethod: "none", clientSecretEncrypted: "" })
        .where(eq(integrationOauthClients.id, row.id));
    }
  }

  return report;
}
