// SPDX-License-Identifier: Apache-2.0

/**
 * Every column holding a `v1:<kid>:` ciphertext of `@appstrate/connect`'s keyring, and the
 * per-kid inventory over them. Read by the API's boot guard and by
 * `scripts/rekey-encrypted-columns.ts`. Import-free: the caller brings the connection.
 */

interface EncryptedColumn {
  table: string;
  column: string;
  /** Primary key columns, in keyset order. */
  key: readonly string[];
  /** Rows whose ciphertext is still read; the others are dead data. */
  live?: string;
}

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: "integration_connections", column: "credentials_encrypted", key: ["id"] },
  { table: "integration_oauth_clients", column: "client_secret_encrypted", key: ["id"] },
  { table: "model_provider_credentials", column: "credentials_encrypted", key: ["id"] },
  { table: "org_proxies", column: "url_encrypted", key: ["id"] },
  {
    table: "runs",
    column: "sink_secret_encrypted",
    key: ["id"],
    // `assertSinkOpen` refuses a closed or expired sink before its secret is decrypted. Both
    // writers set the expiry with the secret, so this predicate rides `idx_runs_sink_expires_at`.
    live: "sink_closed_at IS NULL AND sink_expires_at >= now()",
  },
  { table: "space_smtp_configs", column: "pass_encrypted", key: ["space_id"] },
  {
    table: "space_social_providers",
    column: "client_secret_encrypted",
    key: ["space_id", "provider"],
  },
];

export interface KidCount {
  table: string;
  column: string;
  /** `null`: not a `v1:<kid>:` envelope. */
  kid: string | null;
  count: number;
  /** The group's lowest and highest ciphertext (one value when they coincide). */
  samples: string[];
}

/** The live ciphertexts of a column. `''` is a public OAuth client's "no secret", not a ciphertext. */
export function liveCiphertextWhere({ column, live }: EncryptedColumn): string {
  return `"${column}" <> ''${live ? ` AND ${live}` : ""}`;
}

/** One grouped scan per column: no index covers the kid, so it cannot be cheaper than that. */
export async function countByKid(
  query: (text: string) => Promise<Record<string, unknown>[]>,
): Promise<KidCount[]> {
  const counts: KidCount[] = [];
  for (const spec of ENCRYPTED_COLUMNS) {
    const rows = await query(
      `SELECT CASE WHEN "${spec.column}" ~ '^v1:[A-Za-z0-9_-]{1,32}:'
                   THEN split_part("${spec.column}", ':', 2) END AS kid,
              count(*)::int AS count,
              min("${spec.column}") AS first, max("${spec.column}") AS last
         FROM "${spec.table}" WHERE ${liveCiphertextWhere(spec)}
        GROUP BY 1 ORDER BY 1`,
    );
    for (const row of rows) {
      counts.push({
        table: spec.table,
        column: spec.column,
        kid: row.kid as string | null,
        count: Number(row.count),
        samples: [...new Set([row.first as string, row.last as string])],
      });
    }
  }
  return counts;
}
