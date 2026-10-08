#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-encrypt every keyring ciphertext under the active key, so a retired
 * `CONNECTION_ENCRYPTION_KEYS` entry can be dropped — step 3 of the rotation in `docs/ENV.md`
 * § "Rotating `CONNECTION_ENCRYPTION_KEY`". Run with the platform's env (it decrypts):
 *
 *   bun scripts/rekey-encrypted-columns.ts [--apply] [--batch 500]
 *
 * Dry run: the per-kid inventory. `--apply`: rewrite, batch by batch, each write guarded by the
 * value it read. Exit 0 only when every ciphertext is under the active kid.
 */

import { parseArgs } from "node:util";
import { SQL } from "bun";
import { decrypt, encrypt, opensWithKeyring } from "@appstrate/connect";
import { getEnv } from "../packages/env/src/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  ENCRYPTED_COLUMNS,
  countByKid,
  liveCiphertextWhere,
  type KidCount,
} from "@appstrate/db/encrypted-columns";

export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

interface RekeyResult {
  rekeyed: number;
  /** Changed or deleted between the read and the write. */
  skipped: number;
  /** `table.column key: reason` — never a value. */
  failed: string[];
}

export async function rekeyRetiredKids(
  query: Query,
  options: { retiredKids: readonly string[]; batchSize: number },
): Promise<RekeyResult> {
  const result: RekeyResult = { rekeyed: 0, skipped: 0, failed: [] };
  const kids = options.retiredKids;
  if (kids.length === 0) return result;
  const kidParams = kids.map((_, i) => `$${i + 1}`).join(", ");

  for (const spec of ENCRYPTED_COLUMNS) {
    const keys = spec.key.map((k) => `"${k}"`).join(", ");
    let after: string[] | null = null;
    for (;;) {
      const bound = after
        ? `AND (${keys}) > (${after.map((_, i) => `$${kids.length + i + 1}`).join(", ")})`
        : "";
      const rows = await query(
        `SELECT ${spec.key.map((k) => `"${k}"::text AS "${k}"`).join(", ")}, "${spec.column}" AS blob
           FROM "${spec.table}"
          WHERE ${liveCiphertextWhere(spec)} AND "${spec.column}" LIKE 'v1:%'
            AND split_part("${spec.column}", ':', 2) IN (${kidParams}) ${bound}
          ORDER BY ${keys} LIMIT ${options.batchSize}`,
        [...kids, ...(after ?? [])],
      );
      for (const row of rows) {
        const id = spec.key.map((k) => String(row[k]));
        let fresh: string;
        try {
          fresh = encrypt(decrypt(row.blob as string));
        } catch (error) {
          result.failed.push(
            `${spec.table}.${spec.column} ${id.join("/")}: ${getErrorMessage(error)}`,
          );
          continue;
        }
        const match = spec.key.map((k, i) => `"${k}" = $${i + 3}`).join(" AND ");
        const updated = await query(
          `UPDATE "${spec.table}" SET "${spec.column}" = $1
            WHERE "${spec.column}" = $2 AND ${match} RETURNING 1 AS ok`,
          [fresh, row.blob, ...id],
        );
        if (updated.length > 0) result.rekeyed += 1;
        else result.skipped += 1;
      }
      if (rows.length < options.batchSize) break;
      after = spec.key.map((k) => String(rows.at(-1)![k]));
    }
  }
  return result;
}

/**
 * Prints the inventory, and for each configured kid whether its key opens a sample of the
 * column (`SAMPLE DOES NOT OPEN`: a key replaced under the same id, or only corrupted rows).
 * True when every ciphertext is under the active kid and every sample opens.
 */
export function reportCounts(
  counts: readonly KidCount[],
  keyring: { activeKid: string; retiredKids: readonly string[] },
  out: (line: string) => void,
): boolean {
  let clean = true;
  for (const { table, column, kid, count, samples } of counts) {
    let label =
      kid === null
        ? "NOT AN ENVELOPE"
        : kid === keyring.activeKid
          ? "active"
          : keyring.retiredKids.includes(kid)
            ? "retired"
            : "UNKNOWN";
    if (label !== "active") clean = false;
    if (label === "active" || label === "retired") {
      const opens = samples.some(opensWithKeyring);
      if (!opens) clean = false;
      label += opens ? ", sample opens" : ", SAMPLE DOES NOT OPEN";
    }
    out(`  ${table}.${column}  ${kid ?? "-"} (${label}): ${count}`);
  }
  return clean;
}

if (import.meta.main) {
  let code = 1;
  let sql: SQL | undefined;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" }, batch: { type: "string", default: "500" } },
      strict: true,
    });
    const batchSize = Number(values.batch);
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch must be ≥ 1");
    const env = getEnv();
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is empty — load the platform .env");
    const keyring = {
      activeKid: env.CONNECTION_ENCRYPTION_KEY_ID,
      retiredKids: Object.keys(env.CONNECTION_ENCRYPTION_KEYS),
    };
    sql = new SQL(env.DATABASE_URL, { max: 1 });
    const db = sql;
    const query: Query = (text, params) => db.unsafe(text, params ?? []);
    await query("SET statement_timeout = '120s'");
    const [target] = await query("SELECT current_database() AS name");
    out(`rekey — ${values.apply ? "APPLY" : "DRY RUN"} on database ${target!.name}`);
    out(
      `active kid ${keyring.activeKid}; retired kids: ${keyring.retiredKids.join(", ") || "none"}`,
    );

    if (values.apply) {
      const result = await rekeyRetiredKids(query, { ...keyring, batchSize });
      out(`rekeyed ${result.rekeyed}, skipped ${result.skipped} (changed or deleted meanwhile)`);
      for (const line of result.failed) out(`  FAILED ${line}`);
    }
    out("ciphertexts per kid:");
    const clean = reportCounts(await countByKid(query), keyring, out);
    out(
      clean
        ? "rekey: every ciphertext is under the active kid and opens — the retired keys can be dropped."
        : values.apply
          ? "rekey: ciphertexts remain outside the active kid, or do not open — see the lines above."
          : "rekey: DRY RUN — nothing written. Re-run with --apply to re-encrypt the retired kids.",
    );
    code = clean ? 0 : 1;
  } catch (error) {
    out(`rekey: FAILED — ${getErrorMessage(error)}`);
  } finally {
    await sql?.close();
  }
  process.exit(code);
}
