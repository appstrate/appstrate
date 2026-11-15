#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0054 — `mcp-server` packages folded into the local integrations that ran them (#2220):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0054-fold-mcp-servers.ts [--apply]
 *
 * A local MCP server is now declared INLINE on its integration (`source.server = { type,
 * entry_point, mcp_config, tools }`, payload in the integration's own files) and the `mcp-server`
 * package type is gone. Run BEFORE the new release boots, with the app stopped and `pg_dump` AND a
 * snapshot of object storage taken first (README, step 3): the release's migration `0106` rebuilds
 * the `package_type` enum without `mcp-server` and fails on a row still of that type, so the boot
 * fails until this script has run. Every query is raw SQL comparing `type::text`, so the script
 * reads the schema of either release. Dry run by default (rolled back, no storage
 * write); `--apply` commits; a second `--apply` writes nothing. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`). The storage is the platform's
 * (`S3_BUCKET`, else `FS_STORAGE_PATH`): load the platform's env. Both targets are printed first.
 * Exit 2 as well, before planning, when server versions exist but no server archive is readable
 * (the classic cause: the storage env was not loaded and the default `./data/storage` was read).
 *
 * Per ORG-owned integration whose draft or version still reads `source.server = { name, version }`
 * the referenced server (same organization first, then system) is resolved as the runtime did:
 * a SYSTEM server is its highest version; an org server by the pin, exact version (yanked included)
 * then dist-tag name then semver range (yanked excluded), a missing pin meaning the `latest`
 * dist-tag. A draft folds the server's PUBLISHED version resolved by its own pin; only a server
 * with no published version at all falls back to its draft manifest and draft files. The manifest
 * becomes `source.server = { ...server.server, tools }`, the server's `dev.appstrate/mcp-server`
 * and `dev.appstrate/workspace` `_meta` keys move across, every `mcp_config.env[V]` carrying
 * `${user_config.K}` placeholders becomes `delivery.env[V] = { value, sensitive }` (each placeholder
 * replaced by the value of the auth entry whose `user_config_key ?? envKey` is `K`, `sensitive`
 * if any matched entry is) and every `user_config_key` is dropped. An existing `delivery.env[V]`
 * is never overwritten (the old rule: the integration's direct `delivery.env` wins). The server's
 * files, but its `manifest.json`, join the integration's draft files / version archive and the
 * version's `integrity` and `artifact_size` are recomputed.
 *
 * Two kinds of output lines. UNFOLDED: a draft or version that would still read the reference
 * shape after planning (server not found, pin matching no version, server archive or draft payload
 * missing, the integration's own version archive missing, a placeholder embedded in a larger
 * value with no matching entry, a path both hold with different bytes). NOTES: informational (a
 * whole-value placeholder with no matching entry is dropped, the old runtime delivered nothing for
 * it; an identical-bytes path collision; an already-present `delivery.env[V]`). With `--apply`, any
 * UNFOLDED line makes the script print them all, write NOTHING (no DB write, no upload) and exit
 * 1; a dry run prints them and says so. Before the commit `--apply` verifies, in the transaction,
 * that no org draft or version still has `source.server.name` and no `mcp-server` row is left;
 * otherwise it throws and rolls back.
 *
 * Then every ORG agent / skill / integration draft or version carrying `dependencies.mcp_servers`
 * loses that key (it never launched anything), its archive and integrity rewritten for a version.
 * Then every `api_keys.scopes` / `space_roles.permissions` entry of the retired `mcp-servers`
 * permission resource (`mcp-servers:read|write|delete|share`) is removed.
 * Then every `mcp-server` package — system ones included, boot re-syncs only what
 * `system-packages/` holds — is deleted with its versions, dist tags, dependency rows,
 * `space_packages` rows and (through the deletion outbox, same transaction) its storage objects.
 * An org server no integration references is printed (id, organization): it ran nowhere.
 * System integrations are not rewritten: boot re-syncs them from `system-packages/`. But boot only
 * registers the versions `system-packages/` holds and never deletes, and its registry has no bytes
 * for a superseded one: every SYSTEM integration version still on the retired shape
 * (`source.server.name`) is deleted (printed `<id>@<version>`) with its dist tags and dependency
 * rows, its archive queued on the deletion outbox; the `packages` row stays. A `latest` tag that
 * pointed at a deleted version is re-pointed to the highest remaining version.
 *
 * Ordering. Everything is computed first, from reads. With `--apply` the DB writes run in one
 * transaction, the rewritten archives are uploaded INSIDE it (the transaction stays open during the
 * uploads), then it commits. A failure before the commit rolls the DB back but may leave rewritten
 * archives in storage (same keys): the next run recomputes from the unchanged DB rows and rewrites
 * byte-identical archives (payload already present is identical bytes, zips are deterministic), so
 * re-running repairs it. The archives are overwritten in place, so only a storage snapshot undoes
 * a committed run.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { getEnv } from "../../packages/env/src/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeIntegrity } from "@appstrate/core/integrity";
import { compareVersionsDesc, matchVersion, resolveVersionString } from "@appstrate/core/semver";
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

/** Server versions exist but no server archive is readable: the storage read is the wrong one. */
export class StorageUnreadable extends Error {}

type Json = Record<string, unknown>;
type Files = Record<string, Uint8Array>;

const MANIFEST_FILE = "manifest.json";
const META_KEYS = ["dev.appstrate/mcp-server", "dev.appstrate/workspace"] as const;
const PLACEHOLDER = /^\$\{user_config\.([^}]+)\}$/;
const PLACEHOLDERS = /\$\{user_config\.([^}]+)\}/g;
const encoder = new TextEncoder();
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

export interface FoldedManifest {
  manifest: Json;
  /** Informational: something dropped or skipped on purpose. */
  notes: string[];
  /** The manifest would still lose a value the old runtime delivered: blocks `--apply`. */
  unfolded: string[];
}

/** The `source.server` reference of the retired shape: `{ name, version, vendored? }`. */
export function oldServerRef(manifest: unknown): { name: string; version: string } | null {
  if (!isObject(manifest) || !isObject(manifest.source)) return null;
  const source = manifest.source;
  if (source.kind !== "local" || !isObject(source.server)) return null;
  const { name, version } = source.server;
  if (typeof name !== "string") return null;
  // An absent pin is resolved as the `latest` dist-tag, as the runtime did (empty string).
  return { name, version: typeof version === "string" ? version : "" };
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
  const unfolded: string[] = [];
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

  // The `${user_config.K}` bridge: the old renderer substituted each placeholder, anywhere in the
  // value, from `delivery.env` only (an unmatched one became the empty string).
  const mcpConfig = isObject(folded.mcp_config) ? folded.mcp_config : null;
  const env = mcpConfig && isObject(mcpConfig.env) ? mcpConfig.env : null;
  if (mcpConfig && env) {
    const deliveries = deliveryEnvs(manifest);
    for (const [name, raw] of Object.entries(env)) {
      if (typeof raw !== "string" || !raw.includes("${user_config.")) continue;
      delete env[name];
      const keys = [...raw.matchAll(PLACEHOLDERS)].map((m) => m[1]!);
      const wholeValue = PLACEHOLDER.test(raw);
      // Per auth: the entry each placeholder names, when every placeholder has one.
      const targets: Array<[Json, Json[]]> = [];
      for (const [, delivery] of deliveries) {
        const entries: Json[] = [];
        for (const key of keys) {
          const found = Object.entries(delivery)
            .map(([envKey, entry]): [string, Json] => [
              envKey,
              isObject(entry) ? entry : { value: entry },
            ])
            .find(([envKey, entry]) => (entry.user_config_key ?? envKey) === key);
          if (found) entries.push(found[1]);
        }
        if (entries.length === keys.length) targets.push([delivery, entries]);
      }
      if (targets.length === 0) {
        const why = `mcp_config.env.${name} = ${JSON.stringify(raw)}: a placeholder matches no delivery.env entry`;
        if (wholeValue) notes.push(`${why} — dropped, the old runtime delivered nothing`);
        else unfolded.push(why);
        continue;
      }
      for (const [delivery, entries] of targets) {
        if (name in delivery) {
          notes.push(`delivery.env.${name} already set — kept, mcp_config.env.${name} dropped`);
          continue;
        }
        if (entries.some((entry) => typeof entry.value !== "string")) {
          unfolded.push(`mcp_config.env.${name}: a matched delivery.env entry has no string value`);
          continue;
        }
        let index = 0;
        const value = raw.replace(PLACEHOLDERS, () => entries[index++]!.value as string);
        const copy: Json = { value };
        if (entries.some((entry) => entry.sensitive !== undefined)) {
          copy.sensitive = entries.some((entry) => entry.sensitive === true);
        }
        // Collected after the walk so the iteration above is not mutated.
        pending.push([delivery, name, copy]);
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
  return { manifest, notes, unfolded };
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

/**
 * `files` plus the server payload (all but its manifest). A path both hold with the same bytes is
 * a note; with different bytes it is unfolded (the server would run with the other file).
 */
function withPayload(
  files: Files,
  payload: Files,
  target: string,
  notes: string[],
  unfolded: string[],
): Files {
  const merged: Files = { ...files };
  for (const [path, bytes] of Object.entries(payload)) {
    if (path === MANIFEST_FILE) continue;
    const existing = merged[path];
    if (existing === undefined) merged[path] = bytes;
    else if (bytesEqual(existing, bytes))
      notes.push(`${target}: ${path} exists in both, identical`);
    else unfolded.push(`${target}: ${path} exists in both with different content`);
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
  /** Drafts / versions that would still read the reference shape: `<target>: <why>`. `--apply` refuses. */
  unfolded: string[];
  /** Informational lines: `<target>: <what>`. */
  notes: string[];
  /** `--apply` found unfolded lines and wrote nothing. */
  refused: boolean;
  serversDeleted: number;
  systemServersDeleted: number;
  dependencyRowsDeleted: number;
  storageObjectsQueued: number;
  /** API keys and custom space roles that held an `mcp-servers:*` permission, now removed. */
  apiKeysScrubbed: number;
  spaceRolesScrubbed: number;
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
  const env = getEnv();
  out(
    `storage: ${
      env.S3_BUCKET
        ? `s3 bucket ${env.S3_BUCKET}${env.S3_ENDPOINT ? ` at ${env.S3_ENDPOINT}` : ""}`
        : `filesystem ${resolve(env.FS_STORAGE_PATH)}`
    }`,
  );

  const result: McpServersFold = {
    integrationsFolded: [],
    dependenciesStripped: [],
    orphanServers: [],
    unfolded: [],
    notes: [],
    refused: false,
    serversDeleted: 0,
    systemServersDeleted: 0,
    dependencyRowsDeleted: 0,
    storageObjectsQueued: 0,
    apiKeysScrubbed: 0,
    spaceRolesScrubbed: 0,
    systemVersionsDeleted: [],
    latestRepointed: [],
  };

  // ── Read ────────────────────────────────────────────────────────────────
  const servers = toRows<{ id: string; org_id: string | null; draft_manifest: Json | null }>(
    await db.execute(
      sql`SELECT id, org_id, draft_manifest FROM packages WHERE type::text = 'mcp-server' ORDER BY id`,
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
      WHERE p.type::text = 'mcp-server'`),
  ).map((r): ServerVersionRow => ({
    packageId: r.package_id,
    version: r.version,
    manifest: r.manifest,
    yanked: r.yanked,
  }));
  const serverTags = toRows<{ package_id: string; tag: string; version: string }>(
    await db.execute(sql`SELECT t.package_id, t.tag, v.version
      FROM package_dist_tags t JOIN package_versions v ON v.id = t.version_id
      JOIN packages p ON p.id = t.package_id WHERE p.type::text = 'mcp-server'`),
  );
  const drafts = toRows<{
    id: string;
    type: string;
    org_id: string;
    draft_manifest: Json | null;
  }>(
    await db.execute(sql`SELECT id, type, org_id, draft_manifest FROM packages
      WHERE org_id IS NOT NULL AND type::text <> 'mcp-server' AND draft_manifest IS NOT NULL
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
      WHERE p.org_id IS NOT NULL AND p.type::text <> 'mcp-server'
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

  // A server archive must be readable somewhere, or the storage read is not the platform's.
  if (serverVersions.length > 0) {
    let readable = false;
    for (const v of serverVersions) {
      if (await downloadFile(AGENT_PACKAGES_BUCKET, versionZipKey(v.packageId, v.version))) {
        readable = true;
        break;
      }
    }
    if (!readable) {
      throw new StorageUnreadable(
        `${serverVersions.length} mcp-server version(s) in the database but no server archive is ` +
          "readable in the storage above. The platform's storage env (S3_BUCKET, S3_ENDPOINT, " +
          "FS_STORAGE_PATH, credentials) was probably not loaded and the default ./data/storage " +
          "was read",
      );
    }
  }

  const referenced = new Set<string>();
  const writes: Write[] = [];
  const unfolded = (target: string, why: string) => {
    result.unfolded.push(`${target}: ${why}`);
  };
  const note = (target: string, what: string) => {
    result.notes.push(`${target}: ${what}`);
  };

  /** The server a reference names: the integration's organization first, then system. */
  const findServer = (name: string, orgId: string) =>
    servers.find((s) => s.id === name && s.orgId === orgId) ??
    servers.find((s) => s.id === name && s.orgId === null);

  /**
   * The manifest and payload of the server version the runtime resolved for `pin`: a system server
   * is its highest version; an org server goes exact (yanked visible) → dist-tag → range, an absent
   * pin meaning `latest`. A server with no published version folds its draft, when `draftFallback`.
   */
  const loadServer = async (
    server: ServerRow,
    pin: string,
    draftFallback: boolean,
  ): Promise<{ manifest: Json; payload: Files } | { why: string }> => {
    const rows = serverVersions.filter((v) => v.packageId === server.id);
    if (rows.length === 0) {
      if (!draftFallback) return { why: `server ${server.id} has no published version` };
      if (!server.draftManifest) {
        return { why: `server ${server.id} has no published version and no draft manifest` };
      }
      const payload = await readZip(
        PACKAGE_ITEMS_BUCKET,
        serverDraftKey(server.orgId ?? SYSTEM_STORAGE_NAMESPACE, server.id),
      );
      if (!payload) return { why: `draft payload of server ${server.id} missing` };
      return { manifest: server.draftManifest, payload };
    }
    const live = rows.filter((v) => !v.yanked).map((v) => v.version);
    let version: string | null;
    if (server.orgId === null) {
      version = [...(live.length > 0 ? live : rows.map((v) => v.version))].sort(
        compareVersionsDesc,
      )[0]!;
    } else {
      const tags: Record<string, string> = {};
      for (const t of serverTags) {
        if (t.package_id === server.id && live.includes(t.version)) tags[t.tag] = t.version;
      }
      version = resolveVersionString(
        pin.trim() || "latest",
        rows.map((v) => v.version),
        live,
        tags,
      );
    }
    const row = rows.find((v) => v.version === version);
    if (!row) return { why: `server ${server.id}@${pin.trim() || "latest"} matches no version` };
    const payload = await readZip(AGENT_PACKAGES_BUCKET, versionZipKey(server.id, row.version));
    if (!payload) return { why: `archive of ${server.id}@${row.version} missing` };
    return { manifest: row.manifest, payload };
  };

  // ── Integration drafts and versions with a server reference ─────────────
  for (const row of drafts) {
    const target = `${row.id} (draft)`;
    const ref = oldServerRef(row.draft_manifest);
    if (ref === null) continue;
    const server = findServer(ref.name, row.org_id);
    if (!server) {
      unfolded(target, `server ${ref.name} not found`);
      continue;
    }
    referenced.add(`${server.orgId ?? "_"}:${server.id}`);
    const loaded = await loadServer(server, ref.version, true);
    if ("why" in loaded) {
      unfolded(target, loaded.why);
      continue;
    }
    const folded = foldLocalIntegrationManifest(row.draft_manifest!, loaded.manifest);
    for (const line of folded.notes) note(target, line);
    for (const line of folded.unfolded) unfolded(target, line);
    const key = packageItemKey("integrations", row.org_id, row.id);
    const own = (await readZip(PACKAGE_ITEMS_BUCKET, key)) ?? {};
    const files = withPayload(own, loaded.payload, target, result.notes, result.unfolded);
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
    if (ref !== null) {
      const server = findServer(ref.name, row.org_id);
      if (!server) {
        unfolded(target, `server ${ref.name} not found`);
        continue;
      }
      referenced.add(`${server.orgId ?? "_"}:${server.id}`);
      const loaded = await loadServer(server, ref.version, false);
      if ("why" in loaded) {
        unfolded(target, loaded.why);
        continue;
      }
      const folded = foldLocalIntegrationManifest(row.manifest, loaded.manifest);
      for (const line of folded.notes) note(target, line);
      for (const line of folded.unfolded) unfolded(target, line);
      manifest = folded.manifest;
      payload = loaded.payload;
    } else {
      manifest = stripMcpServers(row.manifest);
    }
    const key = versionZipKey(row.package_id, row.version);
    const own = await readZip(AGENT_PACKAGES_BUCKET, key);
    if (!own) {
      // Only a reference-shape integration blocks `--apply`; a mere dependency key is left in place.
      if (ref !== null) unfolded(target, "version archive missing");
      else note(target, "version archive missing — dependencies.mcp_servers left as it is");
      continue;
    }
    const files = withPayload(own, payload, target, result.notes, result.unfolded);
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
  for (const line of result.notes) out(`  note ${line}`);
  for (const line of result.unfolded) out(`  UNFOLDED ${line}`);
  if (result.unfolded.length > 0 && apply) {
    out(
      `0054: REFUSED — ${result.unfolded.length} unfolded line(s) above. Nothing written (no database ` +
        "write, no upload). Resolve them (restore the missing archive or server, fix the pin), then re-run.",
    );
    result.refused = true;
    return result;
  }
  if (result.unfolded.length > 0) {
    out(
      `0054: ${result.unfolded.length} UNFOLDED line(s): --apply would refuse until they are resolved.`,
    );
  }

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
        // Boot registers a missing `latest` only when it registers a NEW version
        // (`createPackageVersion`); `syncVersion` skips a version already stored with the same
        // integrity, so a package whose current source version is already a remaining row would
        // keep no `latest` at all, and runs resolving it would fail. Re-point to the highest
        // remaining non-yanked version.
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
          sql`DELETE FROM package_version_dependencies WHERE dep_type::text = 'mcp-server' RETURNING id`,
        ),
      );
      result.dependencyRowsDeleted = removedDeps.length;
      await tx.execute(sql`DELETE FROM package_dist_tags WHERE package_id IN
        (SELECT id FROM packages WHERE type::text = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM package_versions WHERE package_id IN
        (SELECT id FROM packages WHERE type::text = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM space_packages WHERE package_id IN
        (SELECT id FROM packages WHERE type::text = 'mcp-server')`);
      await tx.execute(sql`DELETE FROM packages WHERE type::text = 'mcp-server'`);
      result.serversDeleted = servers.length;
      result.systemServersDeleted = servers.filter((s) => s.orgId === null).length;

      // The `mcp-servers` permission resource is gone: a stored grant of it names nothing, and a
      // custom role still holding one is refused on its next edit (`normalizePermissions`).
      result.apiKeysScrubbed = toRows<{ id: string }>(
        await tx.execute(sql`UPDATE api_keys
          SET scopes = ARRAY(SELECT s FROM unnest(scopes) AS s WHERE s NOT LIKE 'mcp-servers:%')
          WHERE EXISTS (SELECT 1 FROM unnest(scopes) AS s WHERE s LIKE 'mcp-servers:%')
          RETURNING id`),
      ).length;
      result.spaceRolesScrubbed = toRows<{ id: string }>(
        await tx.execute(sql`UPDATE space_roles
          SET permissions = ARRAY(SELECT p FROM unnest(permissions) AS p
            WHERE p NOT LIKE 'mcp-servers:%'), updated_at = now()
          WHERE EXISTS (SELECT 1 FROM unnest(permissions) AS p WHERE p LIKE 'mcp-servers:%')
          RETURNING id`),
      ).length;

      // Nothing may still read the reference shape, nor any server row remain: roll back otherwise.
      const [left] = toRows<{ drafts: number; versions: number; servers: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM packages
            WHERE org_id IS NOT NULL AND type::text <> 'mcp-server'
              AND draft_manifest -> 'source' ->> 'kind' = 'local'
              AND draft_manifest -> 'source' -> 'server' ->> 'name' IS NOT NULL) AS drafts,
          (SELECT count(*)::int FROM package_versions pv JOIN packages p ON p.id = pv.package_id
            WHERE p.org_id IS NOT NULL AND p.type::text <> 'mcp-server'
              AND pv.manifest -> 'source' ->> 'kind' = 'local'
              AND pv.manifest -> 'source' -> 'server' ->> 'name' IS NOT NULL) AS versions,
          (SELECT count(*)::int FROM packages WHERE type::text = 'mcp-server') AS servers`),
      );
      // (A dry run with unfolded lines leaves them by definition: it only reports.)
      if (result.unfolded.length === 0 && left!.drafts + left!.versions + left!.servers !== 0) {
        throw new Error(
          `verification failed: ${left!.drafts} draft(s), ${left!.versions} version(s) still on ` +
            `source.server.name, ${left!.servers} mcp-server row(s) left — rolled back`,
        );
      }

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
    ["unfolded (--apply refuses)", String(result.unfolded.length)],
    ["notes", String(result.notes.length)],
    ["stale system integration versions deleted", String(result.systemVersionsDeleted.length)],
    ["mcp-server packages deleted", String(result.serversDeleted)],
    ["  of which system", String(result.systemServersDeleted)],
    ["mcp-server dependency rows deleted", String(result.dependencyRowsDeleted)],
    ["storage objects queued for deletion", String(result.storageObjectsQueued)],
    ["api keys losing mcp-servers:* scopes", String(result.apiKeysScrubbed)],
    ["custom space roles losing mcp-servers:* permissions", String(result.spaceRolesScrubbed)],
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
    const result = await runFoldMcpServers({ apply, out });
    code = result.refused ? 1 : 0;
  } catch (error) {
    if (error instanceof StorageUnreadable) code = 2;
    process.stdout.write(`0054: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
