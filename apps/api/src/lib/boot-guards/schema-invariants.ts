// SPDX-License-Identifier: Apache-2.0

/**
 * Permanent boot refusals about the SHAPE of the database: invariants that hold for as long as the
 * platform exists, not a window a one-off script closes (those are `pending-data-scripts.ts`).
 * Each one detects and refuses; none repairs (`docs/NO_TRANSITIONAL_CODE.md` §3).
 */

import { db, toRows } from "@appstrate/db/client";
import { countByKid, type KidCount } from "@appstrate/db/encrypted-columns";
import { keyringKids, opensWithKeyring } from "@appstrate/connect";
import { logger } from "../logger.ts";

/**
 * Refuse to boot when the RFC 8707 oauth `resources` columns (migration 0006)
 * are absent although the migrator reported nothing pending.
 *
 * drizzle-orm's postgres-js migrator applies migrations by timestamp watermark
 * (`max(created_at)` in `__drizzle_migrations`), NOT by hash-set membership. A
 * production DB whose watermark was corrupted to a future date (known prod
 * incident) reports nothing pending while every migration below that date was
 * never applied — 0006 among them, which adds `resources text[]` to
 * oauth_access_tokens / oauth_consents / oauth_refresh_tokens and re-defaults
 * oauth_clients.level. The pinned better-auth 1.7 oauth-provider then queries
 * columns that do not exist, and token mint fails on resource/MCP flows.
 * Tier 0 cannot reach this state: `applyCorePGliteMigrations` keys on the
 * journal tag, not on a watermark.
 *
 * This used to re-run 0006's DDL here, idempotently, on every boot of every
 * deployment, forever — a broken database made to work silently, with nothing
 * recording when the repair could stop shipping. That is what
 * `docs/NO_TRANSITIONAL_CODE.md` §3 and §5 forbid. The DDL moved to
 * `scripts/migration/0004-oauth-resources-watermark-drift.sql`, run once by an
 * operator; what stays here detects and refuses.
 *
 * NOT retirement machinery, despite replacing a self-heal: it does not refuse a
 * RETIRED FORM, it detects a watermark corruption that — in this function's own
 * words below — "fires for a drift that first appears from here on". The
 * transition it came from is over; the failure mode it guards is not, so
 * `docs/NO_TRANSITIONAL_CODE.md` §4 does not reach it. A transitional-code
 * audit deleted it once on the strength of the resemblance; that was wrong.
 *
 * Refusing rather than warning, deliberately: the drift is not scoped to 0006.
 * It skipped every migration below the corrupted watermark, so a process that
 * kept running would be serving from a schema nobody can enumerate, failing
 * later at arbitrary unrelated queries. One actionable message at boot beats
 * that. The cost is real and accepted — a deployment this used to repair in
 * place now stays down until the script is run.
 *
 * The probe is a signature, not a proof, and the gap is wider than it looks.
 * It sees one migration, so a watermark corrupted *after* 0006 applied leaves
 * these columns present and this check passes with other migrations still
 * missing. Worse for the upgrade path: the self-heal shipped in every release
 * up to this one and ran on every boot, so a database that drifted BEFORE this
 * release already had the columns restored — it will pass here while its
 * watermark is still corrupt. In practice this fires for a drift that first
 * appears from here on, and for restores of a backup taken before the heal.
 *
 * Restoring the columns therefore clears the boot refusal, not the drift.
 * `scripts/migration/0004-…` ships the ledger diagnostic for the real extent,
 * and its header says the same thing.
 *
 * The general check — compare `max(created_at)` in `__drizzle_migrations`
 * against the largest `when` in `meta/_journal.json` — was considered and
 * rejected. It is exact for this incident but refuses boot after any deliberate
 * ROLLBACK, where a database legitimately carries a watermark from a newer
 * release than the code, and turning routine rollbacks into outages costs more
 * than the corruption it would catch. The diagnostic stays a query an operator
 * runs, not a predicate that stops the process.
 *
 * `columnExists` is injected for tests — production reads the live database.
 */
export async function assertOAuthResourceColumnsPresent(
  columnExists: () => Promise<boolean> = oauthResourcesColumnExists,
): Promise<void> {
  if (await columnExists()) return;

  throw new Error(
    "Schema drift: the oauth `resources` columns (migration 0006) are absent even though " +
      "the migrator reported nothing pending. __drizzle_migrations is ahead of the real " +
      "schema, so 0006 — and every other migration below the corrupted watermark — was " +
      "silently skipped. Refusing to boot: token mint would fail at runtime on resource/MCP " +
      "flows, and the rest of the skipped set is unknown. Apply " +
      "scripts/migration/0004-oauth-resources-watermark-drift.sql to this database (it ships " +
      "the diagnostic query for the full extent of the drift), then restart.",
  );
}

async function oauthResourcesColumnExists(): Promise<boolean> {
  const { sql: rawSql } = await import("drizzle-orm");
  const present = toRows(
    await db.execute(rawSql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'oauth_access_tokens'
        AND column_name = 'resources'
      LIMIT 1
    `),
  );
  return present.length > 0;
}

/**
 * Refuse to boot while the database holds a ciphertext under a key id absent from the keyring
 * (a retired key dropped before `scripts/rekey-encrypted-columns.ts` re-encrypted its rows, a
 * misspelt kid): every read of those rows would fail. The inventory is the rekey script's.
 * A configured kid none of whose samples opens is only warned about: dead rows written by an
 * older key under the same id would make a refusal crash-loop on a correct key.
 */
export async function assertKeyringCoversCiphertexts(
  inventory: () => Promise<readonly KidCount[]> = storedCiphertextKids,
  knownKids: ReadonlySet<string> = keyringKids(),
): Promise<void> {
  const missing = new Map<string, string[]>();
  const opens = new Map<string, boolean>();
  for (const { table, column, kid, count, samples } of await inventory()) {
    if (kid === null) continue;
    if (knownKids.has(kid)) {
      opens.set(kid, opens.get(kid) || samples.some(opensWithKeyring));
      continue;
    }
    missing.set(kid, [...(missing.get(kid) ?? []), `${table}.${column} (${count})`]);
  }
  for (const [kid, opened] of opens) {
    if (opened) continue;
    logger.warn("Encryption key opens none of its kid's sampled ciphertexts", {
      kid,
      remedy:
        "a key replaced under the same id? `bun scripts/rekey-encrypted-columns.ts` names the column",
    });
  }
  if (missing.size === 0) return;

  const detail = [...missing].map(([kid, where]) => `'${kid}' in ${where.join(", ")}`);
  throw new Error(
    `Missing encryption key(s): the database holds ciphertexts under ${detail.join("; ")}, ` +
      "and no key with that id is configured. Refusing to boot: every read of those rows " +
      "would fail. Add each missing key to CONNECTION_ENCRYPTION_KEYS (kid → base64 key), " +
      "then restart.",
  );
}

async function storedCiphertextKids(): Promise<KidCount[]> {
  const { sql: rawSql } = await import("drizzle-orm");
  return countByKid(async (text) => toRows(await db.execute(rawSql.raw(text))));
}
