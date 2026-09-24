#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0024 — READ-ONLY pre-flight, run BEFORE deploying #1458 (per-connection
 * runner egress allowlist), with the platform's env loaded (it decrypts):
 *
 *   set -a && . ./.env && set +a && bun scripts/migration/0024-verify-egress-allowlist.ts
 *
 * Two things the release refuses that already sit in the database:
 *
 * 1. MANIFESTS. `integrationManifestSchema` now validates `{$credential.<field>}`
 *    placeholders in `authorized_uris` (the field must be declared and
 *    required; no template on an `oauth2` auth, one declaring `connect` or one
 *    exposing `api_call`), and it runs on every read of a stored manifest — so
 *    a draft or published version breaking the rule fails every connect and
 *    run. Fix a draft by editing it; publish a fixed version for a published one.
 *
 * 2. `@appstrate/ssh` CONNECTIONS. `@appstrate/ssh` 1.0.1 renders its egress
 *    from the connection (`ssh://{$credential.host}:{$credential.port}`); a
 *    bag without a `port`, or with a host the render refuses (an IPv6 literal),
 *    renders to nothing and its runs are denied all egress. The provisioner has
 *    always written `port`, so the expected count is 0; any hit is data to
 *    rewrite before the deploy, not something the runtime falls back on.
 *
 * Prints ids only, never a credential value. Exits 1 while anything remains.
 */

import { SQL } from "bun";
import { integrationManifestSchema } from "@appstrate/core/integration";
import { renderAuthorizedUris } from "@appstrate/afps-shared/credential-template";
import { decryptCredentialsToStringMap } from "@appstrate/connect";

/** Every issue the #1458 rule raises starts with this. */
const TEMPLATE_ISSUE_PREFIX = "authorized_uris entry ";
/** `@appstrate/ssh` 1.0.1's `auths.primary.authorized_uris`. */
const SSH_EGRESS = ["ssh://{$credential.host}:{$credential.port}"];

const url = process.env.DATABASE_URL;
if (!url) {
  process.stdout.write("DATABASE_URL is required — the platform database to read\n");
  process.exit(2);
}
const sql = new SQL(url, { max: 1 });
const { manifests, sshConnections } = await sql.begin(async (tx: SQL) => {
  await tx`SET TRANSACTION READ ONLY`;
  const manifests: { id: string; version: string; manifest: string | null }[] = await tx`
    SELECT p.id, 'draft' AS version, p.draft_manifest::text AS manifest
      FROM packages p WHERE p.type = 'integration'
    UNION ALL
    SELECT p.id, v.version, v.manifest::text
      FROM package_versions v JOIN packages p ON p.id = v.package_id
     WHERE p.type = 'integration'
     ORDER BY 1, 2`;
  const sshConnections: { id: string; credentials_encrypted: string }[] = await tx`
    SELECT id, credentials_encrypted FROM integration_connections
     WHERE integration_package_id = '@appstrate/ssh' AND auth_key = 'primary'
     ORDER BY id`;
  return { manifests, sshConnections };
});
await sql.close();

let manifestIssues = 0;
for (const row of manifests) {
  const parsed = integrationManifestSchema.safeParse(row.manifest && JSON.parse(row.manifest));
  for (const issue of parsed.error?.issues ?? []) {
    if (!issue.message.startsWith(TEMPLATE_ISSUE_PREFIX)) continue;
    manifestIssues += 1;
    const at = issue.path.map(String).join(".");
    process.stdout.write(`${row.id}@${row.version} TEMPLATE ${at}: ${issue.message}\n`);
  }
}

let deniedConnections = 0;
for (const row of sshConnections) {
  const fields = decryptCredentialsToStringMap(row.credentials_encrypted);
  if (renderAuthorizedUris(SSH_EGRESS, fields).length > 0) continue;
  deniedConnections += 1;
  const missing = ["host", "port"].filter((name) => !fields[name]);
  process.stdout.write(
    `@appstrate/ssh connection ${row.id} DENIED ${missing.length > 0 ? `missing ${missing.join(", ")}` : "host or port not renderable"}\n`,
  );
}

process.stdout.write(
  `\n${manifests.length} manifest(s) scanned, ${manifestIssues} template issue(s)\n` +
    `${sshConnections.length} @appstrate/ssh connection(s) scanned, ${deniedConnections} denied all egress\n`,
);
process.exit(manifestIssues + deniedConnections > 0 ? 1 : 0);
