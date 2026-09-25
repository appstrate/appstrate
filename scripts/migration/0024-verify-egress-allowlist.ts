#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0024 — READ-ONLY pre-flight BEFORE deploying #1458, env loaded (it decrypts):
 *   set -a && . ./.env && set +a && bun scripts/migration/0024-verify-egress-allowlist.ts
 * Exits 1 on `@appstrate/ssh` connections that render no egress (expected 0); also
 * lists, informationally, what third-party local runners are now bound to.
 */

import { SQL } from "bun";
import { renderAuthorizedUris } from "@appstrate/afps-shared/credential-template";
import { decryptCredentialsToStringMap } from "@appstrate/connect";

/** `@appstrate/ssh` 1.0.1's `auths.primary.authorized_uris`. */
const SSH_EGRESS = ["ssh://{$credential.host}:{$credential.port}"];

const url = process.env.DATABASE_URL;
if (!url) {
  process.stdout.write("DATABASE_URL is required — the platform database to read\n");
  process.exit(2);
}
const sql = new SQL(url, { max: 1 });
const { sshConnections, localAuths } = await sql.begin(async (tx: SQL) => {
  await tx`SET TRANSACTION READ ONLY`;
  const sshConnections: { id: string; credentials_encrypted: string }[] = await tx`
    SELECT id, credentials_encrypted FROM integration_connections
     WHERE integration_package_id = '@appstrate/ssh' AND auth_key = 'primary'
     ORDER BY id`;
  const localAuths: { at: string; key: string; egress: string; n: number }[] = await tx`
    SELECT r.id || '@' || r.version AS at, a.key,
           CASE WHEN (a.value ->> 'allow_all_uris')::boolean THEN 'allow_all_uris'
                ELSE coalesce(a.value -> 'authorized_uris', '[]')::text END AS egress,
           (SELECT count(*) FROM integration_connections c
             WHERE c.integration_package_id = r.id AND c.auth_key = a.key)::int AS n
      FROM (SELECT id, 'draft', draft_manifest FROM packages WHERE type = 'integration'
            UNION ALL
            SELECT p.id, v.version || CASE WHEN v.yanked THEN ' (yanked)' ELSE '' END, v.manifest
              FROM package_versions v JOIN packages p ON p.id = v.package_id
             WHERE p.type = 'integration') r(id, version, m),
           jsonb_each(r.m -> 'auths') a
     WHERE r.m -> 'source' ->> 'kind' = 'local' AND r.id NOT LIKE '@appstrate/%'
     ORDER BY 1, 2`;
  return { sshConnections, localAuths };
});
await sql.close();

let denied = 0;
for (const row of sshConnections) {
  const fields = decryptCredentialsToStringMap(row.credentials_encrypted);
  if (renderAuthorizedUris(SSH_EGRESS, fields).length > 0) continue;
  denied += 1;
  const missing = ["host", "port"].filter((name) => !fields[name]);
  const why = missing.length > 0 ? `missing ${missing.join(", ")}` : "host or port not renderable";
  process.stdout.write(`@appstrate/ssh connection ${row.id} DENIED ${why}\n`);
}

process.stdout.write("\n-- informational: third-party local runners, bound by these lists --\n");
for (const row of localAuths) {
  process.stdout.write(`${row.at} auth ${row.key}: ${row.egress}, ${row.n} connection(s)\n`);
}

process.stdout.write(
  `\n${sshConnections.length} @appstrate/ssh connection(s) scanned, ${denied} denied all egress\n`,
);
process.exit(denied > 0 ? 1 : 0);
