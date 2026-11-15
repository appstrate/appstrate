#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0054 — `mcp-server` packages folded into the local integrations that ran them (#2220):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0054-fold-mcp-servers.ts [--apply]
 *
 * A local MCP server is now declared INLINE on its integration (`source.server = { type,
 * entry_point, mcp_config, tools }`, payload in the integration's own files) and the
 * `mcp-server` package type is gone. Run after the release's migrations, BEFORE the app starts
 * (`pg_dump` first): the platform refuses to boot while a `type = 'mcp-server'` row exists
 * (`assertMcpServersFolded`). Dry run by default (rolled back, no storage write); `--apply`
 * commits; a second `--apply` writes nothing. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2
 * with neither (`lib/database-target.ts`). The storage is the platform's (`S3_BUCKET`, else
 * `FS_STORAGE_PATH`): load the platform's env.
 *
 * Per ORG-owned integration whose draft or version still reads `source.server = { name, version }`:
 * the referenced server (same organization or system) is resolved — the server's DRAFT for the
 * integration's draft, the highest non-yanked server version satisfying the range for each
 * integration version. The manifest becomes `source.server = { ...server.server, tools:
 * server.tools }`, the server's `dev.appstrate/mcp-server` and `dev.appstrate/workspace` `_meta`
 * keys move across, every `mcp_config.env[V] = "${user_config.K}"` becomes
 * `delivery.env[V] = { value, sensitive }` copied from the auth entry whose
 * `user_config_key ?? envKey` is `K` (V leaves `mcp_config.env`), and every `user_config_key` is
 * dropped. A placeholder with no matching entry is printed and dropped (the old substitution read
 * `delivery.env` only, so the server never received a value for it). The server's files, but its
 * `manifest.json`, are copied into the integration's draft files / version archive and the
 * version's `integrity` and `artifact_size` recomputed. A draft or version whose referenced server
 * or archive cannot be found is printed and left as it is.
 *
 * Then every ORG agent / skill / integration draft or version carrying `dependencies.mcp_servers`
 * loses that key (it never launched anything), its archive and integrity rewritten for a version.
 * Then every `mcp-server` package — system ones included, boot re-syncs only what
 * `system-packages/` holds — is deleted with its versions, dist tags, dependency rows,
 * `space_packages` rows and (through the deletion outbox, same transaction) its storage objects.
 * An org server no integration references is printed (id, organization): it ran nowhere.
 * `package_version_dependencies` rows of type `mcp-server` are removed. System integrations are
 * not rewritten: boot re-syncs them from `system-packages/`. But boot only registers the versions
 * `system-packages/` holds and never deletes, and its registry has no bytes for a superseded one:
 * every SYSTEM integration version still on the retired shape (`source.server.name`) is deleted
 * (printed `<id>@<version>`) with its dist tags and dependency rows, its archive queued on the
 * deletion outbox; the `packages` row stays (boot registers the new version on it). A `latest`
 * tag that pointed at a deleted version is re-pointed to the highest remaining version (none left:
 * boot sync sets it when it registers the new one).
 *
 * Ordering. Everything is computed first, from reads. With `--apply` the DB writes run in one
 * transaction, the rewritten archives are uploaded INSIDE it, then it commits. A failure before the
 * commit rolls the DB back but may leave rewritten archives in storage (same keys): the next run
 * recomputes from the unchanged DB rows and rewrites byte-identical archives (payload already
 * present is not a collision, zips are deterministic), so re-running repairs it. A crash between
 * the last upload and the commit is the same case.
 */

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeIntegrity } from "@appstrate/core/integrity";
import { matchVersion } from "@appstrate/core/semver";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import { downloadFile, uploadFile } from "@appstrate/db/storage";
import { prefixedId } from "@appstrate/db/ids";
import {
  PACKAGE_ITEMS_BUCKET,
  SYSTEM_STORAGE_NAMESPACE,
  packageItemKey,
} from "../../apps/api/src/services/package-items/config.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../apps/api/src/services/package-storage-keys.ts";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import { table } from "./lib/report-table.ts";

/**
 * Where a retired `mcp-server` package's files lived: `packageItemKey`'s layout, whose
 * `storageFolder` no longer names this type.
 */
const serverDraftKey = (ownerNamespace: string, id: string) =>
  `${ownerNamespace}/mcp-servers/${id}.afps`;

class DryRunRollback extends Error {}

type Json = Record<string, unknown>;
type Files = Record<string, Uint8Array>;

const MANIFEST_FILE = "manifest.json";
const META_KEYS = ["dev.appstrate/mcp-server", "dev.appstrate/workspace"] as const;
const PLACEHOLDER = /^\$\{user_config\.([^}]+)\}$/;
const encoder = new TextEncoder();
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

export interface FoldedManifest {
  manifest: Json;
  /** What could not be translated, printed in the report. */
  notes: string[];
}

/** The `source.server` reference of the retired shape: `{ name, version, vendored? }`. */
export function oldServerRef(manifest: unknown): { name: string; version: string } | null {
  if (!isObject(manifest) || !isObject(manifest.source)) return null;
  const source = manifest.source;
  if (source.kind !== "local" || !isObject(source.server)) return null;
  const { name, version } = source.server;
  if (typeof name !== "string") return null;
  return { name, version: typeof version === "string" ? version : "*" };
}

function hasMcpServersDependency(manifest: unknown): boolean {
  return (
    isObject(manifest) && isObject(manifest.dependencies) && "mcp_servers" in manifest.dependencies
  );
}

/** Drop `dependencies.mcp_servers` from a manifest copy. */
function stripMcpServersDependency(manifest: Json): void {
  if (isObject(manifest.dependencies)) delete manifest.dependencies.mcp_servers;
}

/** Every `delivery.env` map of an integration's auths, with the auth's key. */
function deliveryEnvs(manifest: Json): Array<[auth: string, env: Json]> {
  const out: Array<[string, Json]> = [];
  if (!isObject(manifest.auths)) return out;
  for (const [authKey, auth] of Object.entries(manifest.auths)) {
    if (isObject(auth) && isObject(auth.delivery) && isObject(auth.delivery.env)) {
      out.push([authKey, auth.delivery.env]);
    }
  }
  return out;
}

/**
 * The integration manifest with its server folded in. Pure: takes parsed manifests, returns a new
 * one. `server` is the referenced mcp-server's manifest (old shape: `server`, `tools`, `_meta`).
 */
export function foldLocalIntegrationManifest(integration: Json, server: Json): FoldedManifest {
  const manifest = clone(integration);
  const notes: string[] = [];
  const pending: Array<[Json, string, Json]> = [];
  stripMcpServersDependency(manifest);

  const serverBlock = isObject(server.server) ? clone(server.server) : {};
  const tools = Array.isArray(server.tools) ? clone(server.tools) : undefined;
  const folded: Json = { ...serverBlock };
  if (tools !== undefined) folded.tools = tools;
  manifest.source = { ...(manifest.source as Json), server: folded };

  const meta: Json = isObject(manifest._meta) ? manifest._meta : {};
  const serverMeta = isObject(server._meta) ? server._meta : {};
  for (const key of META_KEYS) if (key in serverMeta) meta[key] = clone(serverMeta[key]);
  if (Object.keys(meta).length > 0) manifest._meta = meta;

  // The `${user_config.K}` bridge: the old renderer read the value from `delivery.env` only.
  const mcpConfig = isObject(folded.mcp_config) ? folded.mcp_config : null;
  const env = mcpConfig && isObject(mcpConfig.env) ? mcpConfig.env : null;
  if (mcpConfig && env) {
    const deliveries = deliveryEnvs(manifest);
    for (const [name, raw] of Object.entries(env)) {
      if (typeof raw !== "string" || !raw.includes("${user_config.")) continue;
      delete env[name];
      const key = PLACEHOLDER.exec(raw)?.[1];
      if (key === undefined) {
        notes.push(
          `mcp_config.env.${name} = ${JSON.stringify(raw)}: not a whole-value placeholder`,
        );
        continue;
      }
      let matched = false;
      for (const [, delivery] of deliveries) {
        for (const [envKey, entry] of Object.entries(delivery)) {
          const entryObject = isObject(entry) ? entry : { value: entry };
          if ((entryObject.user_config_key ?? envKey) !== key) continue;
          matched = true;
          const copy: Json = { value: entryObject.value };
          if (entryObject.sensitive !== undefined) copy.sensitive = entryObject.sensitive;
          // Collected after the walk so the iteration above is not mutated.
          pending.push([delivery, name, copy]);
        }
      }
      if (!matched) {
        notes.push(`mcp_config.env.${name}: \${user_config.${key}} matches no delivery.env entry`);
      }
    }
    for (const [delivery, name, copy] of pending.splice(0)) delivery[name] = copy;
    if (Object.keys(env).length === 0) delete mcpConfig.env;
  }
  for (const [, delivery] of deliveryEnvs(manifest)) {
    for (const entry of Object.values(delivery)) {
      if (isObject(entry)) delete entry.user_config_key;
    }
  }
  return { manifest, notes };
}

/** A manifest copy without `dependencies.mcp_servers`. */
export function stripMcpServers(manifest: Json): Json {
  const copy = clone(manifest);
  stripMcpServersDependency(copy);
  return copy;
}

function sortedFiles(files: Files): Files {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

/** `files` plus the server payload (all but its manifest); a path both hold keeps the integration's. */
function withPayload(files: Files, payload: Files, collisions: string[]): Files {
  const merged: Files = { ...files };
  for (const [path, bytes] of Object.entries(payload)) {
    if (path === MANIFEST_FILE) continue;
    const existing = merged[path];
    if (existing === undefined) merged[path] = bytes;
    else if (!bytesEqual(existing, bytes)) collisions.push(path);
  }
  return merged;
}

function archive(files: Files, manifest: Json): Uint8Array {
  return zipArtifact(
    sortedFiles({
      ...files,
      [MANIFEST_FILE]: encoder.encode(JSON.stringify(manifest, null, 2)),
    }),
    6,
  );
}

async function readZip(bucket: string, key: string): Promise<Files | null> {
  const bytes = await downloadFile(bucket, key);
  return bytes ? unzipArtifact(new Uint8Array(bytes)) : null;
}

interface ServerRow {
  id: string;
  orgId: string | null;
  draftManifest: Json | null;
}
interface ServerVersionRow {
  packageId: string;
  version: string;
  manifest: Json;
  yanked: boolean;
}

interface Write {
  /** `draft` rewrites `packages.draft_manifest`; `version` a `package_versions` row. */
  kind: "draft" | "version";
  packageId: string;
  type: string;
  orgId: string;
  version?: string;
  versionRowId?: number;
  manifest: Json;
  /** The write folds a server into an integration (else it only drops `dependencies.mcp_servers`). */
  folds: boolean;
  /** Archive written to storage (`bucket`, `key`), absent when no archive is rewritten. */
  upload?: { bucket: string; key: string; bytes: Uint8Array };
  integrity?: string;
  artifactSize?: number;
}

export interface McpServersFold {
  /** Draft / version rewrites of integrations, by `<id>` or `<id>@<version>`. */
  integrationsFolded: string[];
  /** Manifests that lost `dependencies.mcp_servers` only. */
  dependenciesStripped: string[];
  /** Org servers no integration referenced — deleted. */
  orphanServers: Array<{ id: string; orgId: string }>;
  /** Things left untranslated: `<target>: <why>`. */
  unresolved: string[];
  serversDeleted: number;
  systemServersDeleted: number;
  dependencyRowsDeleted: number;
  storageObjectsQueued: number;
  /** System integration versions still on the retired shape (`<id>@<version>`) — deleted. */
  systemVersionsDeleted: string[];
  /** System packages whose `latest` tag pointed at a deleted version and was re-pointed. */
  latestRepointed: string[];
}

export async function runFoldMcpServers(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<McpServersFold> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const result: McpServersFold = {
    integrationsFolded: [],
    dependenciesStripped: [],
    orphanServers: [],
    unresolved: [],
    serversDeleted: 0,
    systemServersDeleted: 0,
    dependencyRowsDeleted: 0,
    storageObjectsQueued: 0,
    systemVersionsDeleted: [],
    latestRepointed: [],
  };

  // ── Read ────────────────────────────────────────────────────────────────
  const servers = toRows<{ id: string; org_id: string | null; draft_manifest: Json | null }>(
    await db.execute(
      sql`SELECT id, org_id, draft_manifest FROM packages WHERE type = 'mcp-server' ORDER BY id`,
    ),
  ).map((r): ServerRow => ({ id: r.id, orgId: r.org_id, draftManifest: r.draft_manifest }));
  const serverVersions = toRows<{
    package_id: string;
    version: string;
    manifest: Json;
    yanked: boolean;
  }>(
    await db.execute(sql`SELECT pv.package_id, pv.version, pv.manifest, pv.yanked
      FROM package_versions pv JOIN packages p ON p.id = pv.package_id
      WHERE p.type = 'mcp-server'`),
  ).map((r): ServerVersionRow => ({
    packageId: r.package_id,
    version: r.version,
    manifest: r.manifest,
    yanked: r.yanked,
  }));
  const drafts = toRows<{
    id: string;
    type: string;
    org_id: string;
    draft_manifest: Json | null;
  }>(
    await db.execute(sql`SELECT id, type, org_id, draft_manifest FROM packages
      WHERE org_id IS NOT NULL AND type <> 'mcp-server' AND draft_manifest IS NOT NULL
      ORDER BY id`),
  );
  const versions = toRows<{
    row_id: number;
    package_id: string;
    type: string;
    org_id: string;
    version: string;
    manifest: Json;
  }>(
    await db.execute(sql`SELECT pv.id AS row_id, pv.package_id, p.type, p.org_id, pv.version,
        pv.manifest
      FROM package_versions pv JOIN packages p ON p.id = pv.package_id
      WHERE p.org_id IS NOT NULL AND p.type <> 'mcp-server'
      ORDER BY pv.package_id, pv.id`),
  );
  // System integration versions on the retired shape: boot only registers what `system-packages/`
  // holds and never deletes, and the boot registry carries no bytes for them.
  const staleSystem = toRows<{
    row_id: number;
    package_id: string;
    version: string;
    manifest: Json;
  }>(
    await db.execute(sql`SELECT pv.id AS row_id, pv.package_id, pv.version, pv.manifest
      FROM package_versions pv JOIN packages p ON p.id = pv.package_id
      WHERE p.org_id IS NULL AND p.type = 'integration'
      ORDER BY pv.package_id, pv.id`),
  ).filter((r) => oldServerRef(r.manifest) !== null);
  for (const r of staleSystem) {
    result.systemVersionsDeleted.push(`${r.package_id}@${r.version}`);
    out(`  stale system version ${r.package_id}@${r.version}: retired local shape — deleted`);
  }
  out(
    `mcp-server packages: ${servers.length} (${servers.filter((s) => s.orgId === null).length} system), versions: ${serverVersions.length}`,
  );

  const referenced = new Set<string>();
  const writes: Write[] = [];
  const unresolved = (target: string, why: string) => {
    result.unresolved.push(`${target}: ${why}`);
  };

  /** The server a reference names: the integration's organization first, then system. */
  const findServer = (name: string, orgId: string) =>
    servers.find((s) => s.id === name && s.orgId === orgId) ??
    servers.find((s) => s.id === name && s.orgId === null);

  // ── Integration drafts and versions with a server reference ─────────────
  for (const row of drafts) {
    const target = `${row.id} (draft)`;
    const ref = oldServerRef(row.draft_manifest);
    if (ref === null) continue;
    const server = findServer(ref.name, row.org_id);
    if (!server) {
      unresolved(target, `server ${ref.name} not found`);
      continue;
    }
    referenced.add(`${server.orgId ?? "_"}:${server.id}`);
    if (!server.draftManifest) {
      unresolved(target, `server ${ref.name} has no draft manifest`);
      continue;
    }
    const folded = foldLocalIntegrationManifest(row.draft_manifest!, server.draftManifest);
    for (const note of folded.notes) unresolved(target, note);
    const payload =
      (await readZip(
        PACKAGE_ITEMS_BUCKET,
        serverDraftKey(server.orgId ?? SYSTEM_STORAGE_NAMESPACE, server.id),
      )) ?? {};
    const key = packageItemKey("integrations", row.org_id, row.id);
    const own = (await readZip(PACKAGE_ITEMS_BUCKET, key)) ?? {};
    const collisions: string[] = [];
    const files = withPayload(own, payload, collisions);
    for (const path of collisions) unresolved(target, `${path} exists in both, integration kept`);
    const bytes = archive(files, folded.manifest);
    writes.push({
      kind: "draft",
      packageId: row.id,
      type: row.type,
      orgId: row.org_id,
      folds: true,
      manifest: folded.manifest,
      upload: { bucket: PACKAGE_ITEMS_BUCKET, key, bytes },
    });
  }

  for (const row of versions) {
    const target = `${row.package_id}@${row.version}`;
    const ref = oldServerRef(row.manifest);
    const stale = hasMcpServersDependency(row.manifest);
    if (ref === null && !stale) continue;
    let manifest: Json;
    let payload: Files = {};
    const collisions: string[] = [];
    if (ref !== null) {
      const server = findServer(ref.name, row.org_id);
      const candidates = serverVersions.filter((v) => v.packageId === ref.name);
      const live = candidates.filter((v) => !v.yanked);
      const best = matchVersion(
        (live.length > 0 ? live : candidates).map((v) => v.version),
        ref.version,
      );
      const serverVersion = candidates.find((v) => v.version === best);
      if (!server || !serverVersion) {
        unresolved(target, `server ${ref.name}@${ref.version} not found`);
        continue;
      }
      referenced.add(`${server.orgId ?? "_"}:${server.id}`);
      const folded = foldLocalIntegrationManifest(row.manifest, serverVersion.manifest);
      for (const note of folded.notes) unresolved(target, note);
      manifest = folded.manifest;
      const serverZip = await readZip(
        AGENT_PACKAGES_BUCKET,
        versionZipKey(server.id, serverVersion.version),
      );
      if (!serverZip) {
        unresolved(target, `archive of ${server.id}@${serverVersion.version} missing`);
        continue;
      }
      payload = serverZip;
    } else {
      manifest = stripMcpServers(row.manifest);
    }
    const key = versionZipKey(row.package_id, row.version);
    const own = await readZip(AGENT_PACKAGES_BUCKET, key);
    if (!own) {
      unresolved(target, "version archive missing");
      continue;
    }
    const files = withPayload(own, payload, collisions);
    for (const path of collisions) unresolved(target, `${path} exists in both, integration kept`);
    const bytes = archive(files, manifest);
    writes.push({
      kind: "version",
      packageId: row.package_id,
      type: row.type,
      orgId: row.org_id,
      version: row.version,
      versionRowId: row.row_id,
      folds: ref !== null,
      manifest,
      upload: { bucket: AGENT_PACKAGES_BUCKET, key, bytes },
      integrity: computeIntegrity(bytes),
      artifactSize: bytes.byteLength,
    });
  }

  // Drafts that only lose `dependencies.mcp_servers` (agents and skills keep their manifest in the
  // row; an integration with a server reference was handled above).
  for (const row of drafts) {
    if (oldServerRef(row.draft_manifest) !== null || !hasMcpServersDependency(row.draft_manifest)) {
      continue;
    }
    const manifest = stripMcpServers(row.draft_manifest!);
    const write: Write = {
      kind: "draft",
      packageId: row.id,
      type: row.type,
      orgId: row.org_id,
      folds: false,
      manifest,
    };
    if (row.type === "integration") {
      // An integration stores `manifest.json` in its draft files too.
      const key = packageItemKey("integrations", row.org_id, row.id);
      const own = await readZip(PACKAGE_ITEMS_BUCKET, key);
      if (own) write.upload = { bucket: PACKAGE_ITEMS_BUCKET, key, bytes: archive(own, manifest) };
    }
    writes.push(write);
  }

  for (const write of writes) {
    const label = `${write.packageId}${write.kind === "version" ? `@${write.version}` : " (draft)"}`;
    (write.folds ? result.integrationsFolded : result.dependenciesStripped).push(label);
  }

  for (const server of servers) {
    if (server.orgId !== null && !referenced.has(`${server.orgId}:${server.id}`)) {
      out(
        `  orphan server ${server.id} (organization ${server.orgId}): referenced by no integration — deleted`,
      );
      result.orphanServers.push({ id: server.id, orgId: server.orgId });
    }
  }
  for (const line of result.unresolved) out(`  unresolved ${line}`);

  // ── Write ───────────────────────────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);

      for (const write of writes) {
        const manifestJson = JSON.stringify(write.manifest);
        if (write.kind === "draft") {
          await tx.execute(sql`UPDATE packages
            SET draft_manifest = ${manifestJson}::jsonb, lock_version = lock_version + 1
            WHERE id = ${write.packageId}`);
        } else {
          await tx.execute(sql`UPDATE package_versions
            SET manifest = ${manifestJson}::jsonb, integrity = ${write.integrity!},
              artifact_size = ${write.artifactSize!}
            WHERE id = ${write.versionRowId!}`);
        }
      }

      const deletions = [
        ...servers.map((s) => ({
          bucket: PACKAGE_ITEMS_BUCKET,
          key: serverDraftKey(s.orgId ?? SYSTEM_STORAGE_NAMESPACE, s.id),
        })),
        ...serverVersions.map((v) => ({
          bucket: AGENT_PACKAGES_BUCKET,
          key: versionZipKey(v.packageId, v.version),
        })),
      ];
      for (const { bucket, key } of deletions) {
        await tx.execute(sql`INSERT INTO storage_deletion_jobs (id, bucket, storage_key, reason)
          VALUES (${prefixedId("sdj")}, ${bucket}, ${key}, 'mcp_server_folded')
          ON CONFLICT DO NOTHING`);
      }
      result.storageObjectsQueued = deletions.length;

      if (staleSystem.length > 0) {
        const ids = sql.join(
          staleSystem.map((r) => sql`${r.row_id}`),
          sql`, `,
        );
        const latest = toRows<{ package_id: string }>(
          await tx.execute(sql`SELECT package_id FROM package_dist_tags
            WHERE tag = 'latest' AND version_id IN (${ids})`),
        ).map((r) => r.package_id);
        await tx.execute(sql`DELETE FROM package_dist_tags WHERE version_id IN (${ids})`);
        await tx.execute(
          sql`DELETE FROM package_version_dependencies WHERE version_id IN (${ids})`,
        );
        await tx.execute(sql`DELETE FROM package_versions WHERE id IN (${ids})`);
        for (const r of staleSystem) {
          await tx.execute(sql`INSERT INTO storage_deletion_jobs (id, bucket, storage_key, reason)
            VALUES (${prefixedId("sdj")}, ${AGENT_PACKAGES_BUCKET}, ${versionZipKey(r.package_id, r.version)},
              'mcp_server_folded')
            ON CONFLICT DO NOTHING`);
        }
        result.storageObjectsQueued += staleSystem.length;
        // Boot sync registers `latest` for a package with none, but re-point to what remains
        // here so the tag never dangles in between: the highest remaining non-yanked version.
        for (const packageId of new Set(latest)) {
          const rows = toRows<{ id: number; version: string }>(
            await tx.execute(sql`SELECT id, version FROM package_versions
              WHERE package_id = ${packageId} AND NOT yanked`),
          );
          const best = matchVersion(
            rows.map((r) => r.version),
            "*",
          );
          const row = rows.find((r) => r.version === best);
          if (!row) continue;
          await tx.execute(sql`INSERT INTO package_dist_tags (package_id, tag, version_id)
            VALUES (${packageId}, 'latest', ${row.id})
            ON CONFLICT (package_id, tag) DO UPDATE SET version_id = EXCLUDED.version_id, updated_at = now()`);
          result.latestRepointed.push(`${packageId} → ${row.version}`);
        }
      }

      const removedDeps = toRows<{ id: number }>(
        await tx.execute(
          sql`DELETE FROM package_version_dependencies WHERE dep_type = 'mcp-server' RETURNING id`,
        ),
      );
      result.dependencyRowsDeleted = removedDeps.length;
      await tx.execute(sql`DELETE FROM package_dist_tags WHERE package_id IN
        (SELECT id FROM packages WHERE type = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM package_versions WHERE package_id IN
        (SELECT id FROM packages WHERE type = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM space_packages WHERE package_id IN
        (SELECT id FROM packages WHERE type = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM packages WHERE type = 'mcp-server'`);
      result.serversDeleted = servers.length;
      result.systemServersDeleted = servers.filter((s) => s.orgId === null).length;

      // Uploaded last and inside the transaction: a failed upload rolls the database back.
      if (apply) {
        for (const write of writes) {
          if (write.upload) {
            await uploadFile(write.upload.bucket, write.upload.key, write.upload.bytes);
          }
        }
      }
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    report(result, out);
    out("0054: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  report(result, out);
  out("0054: APPLIED — committed.");
  return result;
}

function report(result: McpServersFold, out: (line: string) => void): void {
  const rows: string[][] = [
    ["integrations folded (drafts + versions)", String(result.integrationsFolded.length)],
    ["manifests losing dependencies.mcp_servers", String(result.dependenciesStripped.length)],
    ["orphan org servers deleted", String(result.orphanServers.length)],
    ["unresolved (left as is / dropped)", String(result.unresolved.length)],
    ["stale system integration versions deleted", String(result.systemVersionsDeleted.length)],
    ["mcp-server packages deleted", String(result.serversDeleted)],
    ["  of which system", String(result.systemServersDeleted)],
    ["mcp-server dependency rows deleted", String(result.dependencyRowsDeleted)],
    ["storage objects queued for deletion", String(result.storageObjectsQueued)],
  ];
  for (const line of table(["what", "count"], rows)) out(line);
  for (const label of result.integrationsFolded) out(`  folded ${label}`);
  for (const label of result.dependenciesStripped) out(`  stripped ${label}`);
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0054 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runFoldMcpServers({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0054: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
