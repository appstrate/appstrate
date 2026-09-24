#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0024 — READ-ONLY pre-flight BEFORE deploying #1458, env loaded (it decrypts):
 *   set -a && . ./.env && set +a && bun scripts/migration/0024-verify-egress-allowlist.ts
 * Exits 1 on manifests whose templated `authorized_uris` the schema now refuses
 * (fix the draft / publish a fixed version) or on `@appstrate/ssh` connections
 * that render no egress (expected 0). Also lists, informationally, third-party
 * local runners' grants and mcp-server runtime (flagging `uv`, which resolves its
 * dependencies at startup through that egress) and agents pinned to
 * `@appstrate/ssh` 1.0.0 (`ssh://**`).
 */

import { SQL } from "bun";
import { integrationManifestSchema } from "@appstrate/core/integration";
import { effectiveMcpServerType, type McpServerManifest } from "@appstrate/core/mcp-server-meta";
import { renderAuthorizedUris } from "@appstrate/afps-shared/credential-template";
import { decryptCredentialsToStringMap } from "@appstrate/connect";

const TEMPLATE_ISSUE_PREFIX = "authorized_uris entry ";
/** `@appstrate/ssh` 1.0.1's `auths.primary.authorized_uris`. */
const SSH_EGRESS = ["ssh://{$credential.host}:{$credential.port}"];
const UV_NOTE = " — resolves deps at startup: declare the index in authorized_uris or vendor them";

interface AuthGrant {
  authorized_uris?: string[];
  allow_all_uris?: boolean;
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stdout.write("DATABASE_URL is required — the platform database to read\n");
  process.exit(2);
}
const sql = new SQL(url, { max: 1 });
const { manifests, sshConnections, localIntegrations, mcpServers, connectionCounts, sshPins } =
  await sql.begin(async (tx: SQL) => {
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
    const localIntegrations: {
      id: string;
      version: string;
      server: string | null;
      auths: string | null;
    }[] = await tx`
      SELECT id, version, m -> 'source' -> 'server' ->> 'name' AS server,
             (m -> 'auths')::text AS auths FROM (
        SELECT p.id, 'draft', p.draft_manifest
          FROM packages p WHERE p.type = 'integration'
        UNION ALL
        SELECT p.id, v.version || CASE WHEN v.yanked THEN ' (yanked)' ELSE '' END, v.manifest
          FROM package_versions v JOIN packages p ON p.id = v.package_id
         WHERE p.type = 'integration'
      ) r(id, version, m)
       WHERE m -> 'source' ->> 'kind' = 'local' AND id NOT LIKE '@appstrate/%'
       ORDER BY 1, 2`;
    // The runtime an unpinned spawn gets: the `latest` dist-tag, else the draft.
    const mcpServers: { id: string; version: string; manifest: string | null }[] = await tx`
      SELECT p.id, coalesce(v.version, 'draft') AS version,
             coalesce(v.manifest, p.draft_manifest)::text AS manifest
        FROM packages p
        LEFT JOIN package_dist_tags t ON t.package_id = p.id AND t.tag = 'latest'
        LEFT JOIN package_versions v ON v.id = t.version_id
       WHERE p.type = 'mcp-server'`;
    const connectionCounts: { id: string; auth_key: string; n: number }[] = await tx`
      SELECT integration_package_id AS id, auth_key, count(*)::int AS n
        FROM integration_connections
       WHERE integration_package_id NOT LIKE '@appstrate/%'
       GROUP BY 1, 2`;
    const sshPins: { id: string; version: string; range: string }[] = await tx`
      SELECT id, version, range FROM (
        SELECT p.id, 'draft', p.draft_manifest -> 'dependencies' -> 'integrations' ->> '@appstrate/ssh'
          FROM packages p WHERE p.type = 'agent' AND NOT p.ephemeral
        UNION ALL
        SELECT p.id, v.version, v.manifest -> 'dependencies' -> 'integrations' ->> '@appstrate/ssh'
          FROM package_versions v JOIN packages p ON p.id = v.package_id
         WHERE p.type = 'agent' AND NOT p.ephemeral
      ) r(id, version, range)
       WHERE range IS NOT NULL
       ORDER BY 1, 2`;
    return { manifests, sshConnections, localIntegrations, mcpServers, connectionCounts, sshPins };
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

process.stdout.write("\n-- informational: third-party local runners, bound by these lists --\n");
const connectionsOf = new Map(connectionCounts.map((c) => [`${c.id} ${c.auth_key}`, c.n]));
const typeOf = new Map(
  mcpServers.map((s) => {
    const manifest = JSON.parse(s.manifest ?? "null") as McpServerManifest | null;
    const type = (manifest && effectiveMcpServerType(manifest)) ?? "undeclared";
    return [s.id, { type, at: `${s.id}@${s.version}` }];
  }),
);
let uvRunners = 0;
for (const row of localIntegrations) {
  const server = row.server ? typeOf.get(row.server) : undefined;
  const runtime = server ? `${server.type} (${server.at})` : `unknown (${row.server} not found)`;
  const uv = server?.type === "uv";
  if (uv) uvRunners += 1;
  process.stdout.write(`${row.id}@${row.version} runtime ${runtime}${uv ? UV_NOTE : ""}\n`);
  const auths = (JSON.parse(row.auths ?? "null") ?? {}) as Record<string, AuthGrant>;
  for (const [key, auth] of Object.entries(auths)) {
    const grant = auth.allow_all_uris
      ? "allow_all_uris"
      : JSON.stringify(auth.authorized_uris ?? []);
    const n = connectionsOf.get(`${row.id} ${key}`) ?? 0;
    process.stdout.write(`${row.id}@${row.version} auth ${key}: ${grant}, ${n} connection(s)\n`);
  }
}
const sshExactPins = sshPins.filter(
  (r) => Bun.semver.satisfies("1.0.0", r.range) && !Bun.semver.satisfies("1.0.1", r.range),
);
for (const row of sshExactPins) {
  process.stdout.write(
    `${row.id}@${row.version} pins @appstrate/ssh ${row.range}: keeps ssh://**\n`,
  );
}

process.stdout.write(
  `\n${manifests.length} manifest(s) scanned, ${manifestIssues} template issue(s)\n` +
    `${sshConnections.length} @appstrate/ssh connection(s) scanned, ${deniedConnections} denied all egress\n` +
    `${localIntegrations.length} third-party local integration version(s) (${uvRunners} on uv), ${sshExactPins.length} agent version(s) pinned to @appstrate/ssh 1.0.0 (informational)\n`,
);
process.exit(manifestIssues + deniedConnections > 0 ? 1 : 0);
