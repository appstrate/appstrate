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

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * The run reached the data and some rows need an operator's attention — rows
 * whose ciphertext did not open were reported and skipped.
 */
export const EXIT_ROWS_NEED_ATTENTION = 1;

/**
 * The run never got to look at the data at all: the table or the database was
 * not there. DISTINCT from {@link EXIT_ROWS_NEED_ATTENTION} on purpose — "I
 * inspected your data and some rows need attention" and "I never got to look"
 * demand different responses, and a wrapper script has no other way to tell
 * them apart.
 */
export const EXIT_COULD_NOT_RUN = 2;

/** A thrown value turned into something an operator can act on. */
export interface BackfillFailure {
  /** Ready to print, no trailing newline. Never contains a secret. */
  message: string;
  /** What the process should exit with. */
  exitCode: number;
}

/** `relation … does not exist` — the table is not in this database. */
const UNDEFINED_TABLE = "42P01";

/**
 * Codes that all mean "the database was never reached or never opened":
 * connection refused, host not resolvable, credentials rejected
 * (`invalid_password` / `invalid_authorization_specification`), and no such
 * database (`invalid_catalog_name` — what Postgres and PGlite both answer when
 * the name in the URL names nothing).
 */
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "28P01", "28000", "3D000"]);

/**
 * Every `code` along the `cause` chain, outermost first.
 *
 * The chain matters: a Drizzle query does not throw the driver's error, it
 * throws a `DrizzleQueryError` *wrapping* it, and only the wrapped error
 * carries the SQLSTATE. Checking `err.code` alone sees `undefined` for every
 * database failure this script can actually hit.
 */
function codeChain(err: unknown): string[] {
  const codes: string[] = [];
  let cursor: unknown = err;
  // Bounded: a malformed `cause` cycle must not hang an operator's terminal.
  for (let depth = 0; cursor !== null && cursor !== undefined && depth < 8; depth += 1) {
    const code: unknown = (cursor as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * The innermost message in the chain, collapsed onto one line.
 *
 * Innermost, because the wrappers restate the query rather than the failure:
 * `DrizzleQueryError`'s message is the SQL, and the driver error it wraps is
 * the thing that actually went wrong. Taking the outermost would bury the cause
 * under 140 characters of SELECT.
 */
function rootMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let cursor: unknown = err;
  for (let depth = 0; cursor !== null && cursor !== undefined && depth < 8; depth += 1) {
    if (cursor instanceof Error && cursor.message !== "") message = cursor.message;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return message.replace(/\s+/g, " ").trim();
}

/**
 * Explain a failure that stopped the backfill before it could report anything.
 *
 * Pure, so the classification is testable without a database — the point being
 * that the repair script an error message tells an operator to run must not
 * itself fail as a stack trace into `node_modules`.
 *
 * NEVER echoes `DATABASE_URL` or `CONNECTION_ENCRYPTION_KEY`: this output is
 * exactly what gets pasted into a ticket, and the connection string carries a
 * password. The remedies name the variable to check, never its value.
 */
export function explainBackfillFailure(err: unknown): BackfillFailure {
  const codes = codeChain(err);

  if (codes.includes(UNDEFINED_TABLE)) {
    return {
      exitCode: EXIT_COULD_NOT_RUN,
      message:
        `backfill-public-oauth-clients: table \`integration_oauth_clients\` does not exist.\n` +
        `  The database this connected to is not an Appstrate platform database, or the\n` +
        `  platform's migrations have never been applied to it. Check which database\n` +
        `  DATABASE_URL selects. Migrations are applied automatically when the platform\n` +
        `  boots, so booting the platform once against that database is normally enough.`,
    };
  }

  const unreachable = codes.find((code) => UNREACHABLE.has(code));
  if (unreachable !== undefined) {
    return {
      exitCode: EXIT_COULD_NOT_RUN,
      message:
        `backfill-public-oauth-clients: could not reach the database (${unreachable}).\n` +
        `  Check DATABASE_URL — host, port, database name and credentials — and that the\n` +
        `  server is running and reachable from here. The URL itself is not printed: it\n` +
        `  carries a password.`,
    };
  }

  return {
    exitCode: EXIT_COULD_NOT_RUN,
    message: `backfill-public-oauth-clients: ${rootMessage(err)}`,
  };
}
