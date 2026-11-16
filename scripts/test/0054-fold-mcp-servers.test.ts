// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0054` against the test database and the filesystem storage of tier 0: a local
 * integration's draft and versions take their referenced mcp-server's `server` block, tools, `_meta`
 * and payload files, the `${user_config.K}` bridge becomes `delivery.env` entries, an agent loses
 * `dependencies.mcp_servers`, every `mcp-server` package (orphans and system ones included) is
 * deleted, a dry run writes nothing and a second `--apply` finds nothing. Resolution reproduces the
 * runtime (dist-tag / yanked / system / `latest`), an unfoldable draft or version makes `--apply`
 * refuse and write nothing, and stored `mcp-servers:*` grants are removed. The release migration
 * `0106` rebuilds `package_type` without `mcp-server`: it fails while a server row remains and
 * succeeds once the script has run. The test database is migrated past `0106`, so the label is put
 * back for this file and `0106` is replayed at the end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import { deleteFile, downloadFile, uploadFile } from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import {
  foldLocalIntegrationManifest,
  runFoldMcpServers,
  StorageUnreadable,
} from "../migration/0054-fold-mcp-servers.ts";
import {
  PACKAGE_ITEMS_BUCKET,
  packageItemKey,
} from "../../apps/api/src/services/package-items/config.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../apps/api/src/services/package-storage-keys.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import {
  seedApiKey,
  seedPackage,
  seedPackageVersion,
  seedSpaceRole,
} from "../../apps/api/test/helpers/seed.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SERVER = "@t0054/srv";
const ORPHAN = "@t0054/orphan";
const SYSTEM_SERVER = "@appstrate/t0054-system-srv";
const INTEGRATION = "@t0054/int";
const AGENT = "@t0054/agent";

const lines: string[] = [];

/** The statements of the release migration that drops the `mcp-server` label. */
const migration0106 = async () =>
  (
    await Bun.file(
      resolve(
        import.meta.dir,
        "../../packages/db/drizzle/0106_package_type_without_mcp_server.sql",
      ),
    ).text()
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

beforeAll(async () => {
  await db.execute(sql.raw(`ALTER TYPE package_type ADD VALUE IF NOT EXISTS 'mcp-server'`));
});

afterAll(async () => {
  await truncateAll();
  const statements = await migration0106();
  await db.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
});
const run = (apply: boolean) => runFoldMcpServers({ apply, out: (line) => lines.push(line) });

const serverManifest = (version: string, name = SERVER) => ({
  name,
  version,
  type: "mcp-server",
  server: {
    type: "node",
    entry_point: "server/index.ts",
    mcp_config: {
      command: "bun",
      args: ["server/index.ts"],
      env: { TOKEN: "${user_config.token}", LITERAL: "x", ORPHANED: "${user_config.nowhere}" },
    },
  },
  tools: [{ name: "do_it", description: "Does it" }],
  _meta: {
    "dev.appstrate/mcp-server": { runtime: "bun" },
    "dev.appstrate/workspace": { mount: "rw" },
  },
});

const integrationManifest = (serverRange: string) => ({
  name: INTEGRATION,
  version: "1.0.0",
  type: "integration",
  source: { kind: "local", server: { name: SERVER, version: serverRange } },
  auths: {
    api: {
      type: "api_key",
      delivery: {
        env: {
          API_TOKEN: { value: "{$credential.token}", sensitive: true, user_config_key: "token" },
        },
      },
    },
  },
  dependencies: { mcp_servers: { [SERVER]: serverRange } },
});

const agentManifest = {
  name: AGENT,
  version: "1.0.0",
  type: "agent",
  dependencies: { mcp_servers: { [SERVER]: "^1.0.0" }, skills: {} },
};

const zip = (files: Record<string, string>) =>
  zipArtifact(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])), 6);

const keys: Array<[string, string]> = [];
async function put(bucket: string, key: string, files: Record<string, string>): Promise<void> {
  keys.push([bucket, key]);
  await uploadFile(bucket, key, zip(files));
}

/** The retired type's row: `PackageType` no longer carries it, the enum label does. */
async function seedServer(id: string, orgId: string | null, draft: object, home: string | null) {
  await db.execute(sql`INSERT INTO packages (id, org_id, type, source, draft_manifest, home_space_id)
    VALUES (${id}, ${orgId}, 'mcp-server', ${orgId === null ? "system" : "local"},
      ${JSON.stringify(draft)}::jsonb, ${home})`);
}
async function seedServerVersion(id: string, version: string) {
  await db.execute(sql`INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest)
    VALUES (${id}, ${version}, 'sha256-x', 1, ${JSON.stringify(serverManifest(version, id))}::jsonb)`);
}

const one = async <T>(query: ReturnType<typeof sql>) => toRows<T>(await db.execute(query))[0]!;

let ctx: TestContext;
let home: string;

async function seedAll() {
  home = ctx.defaultSpaceId;
  const org = ctx.orgId;
  await seedServer(SERVER, org, serverManifest("1.1.0"), home);
  await put(PACKAGE_ITEMS_BUCKET, `${org}/mcp-servers/${SERVER}.afps`, {
    "manifest.json": "{}",
    "server/index.ts": "// draft",
  });
  for (const v of ["1.0.0", "1.1.0"]) {
    await seedServerVersion(SERVER, v);
    await put(AGENT_PACKAGES_BUCKET, versionZipKey(SERVER, v), {
      "manifest.json": "{}",
      "server/index.ts": `// v${v}`,
    });
  }
  await seedServer(ORPHAN, org, serverManifest("1.0.0", ORPHAN), home);
  await seedServer(SYSTEM_SERVER, null, serverManifest("1.0.0", SYSTEM_SERVER), null);
  await seedServerVersion(SYSTEM_SERVER, "1.0.0");
  await db.execute(sql`INSERT INTO package_dist_tags (package_id, tag, version_id)
    SELECT package_id, 'latest', id FROM package_versions WHERE package_id = ${SERVER} AND version = '1.1.0'`);
  await db.execute(sql`INSERT INTO space_packages (space_id, package_id, enabled)
    VALUES (${home}, ${SERVER}, true)`);

  await seedPackage({
    id: INTEGRATION,
    orgId: org,
    type: "integration",
    draftManifest: integrationManifest("^1.0.0"),
  });
  await put(PACKAGE_ITEMS_BUCKET, packageItemKey("integrations", org, INTEGRATION), {
    "manifest.json": JSON.stringify(integrationManifest("^1.0.0")),
    "INTEGRATION.md": "# doc",
  });
  const version = await seedPackageVersion({
    packageId: INTEGRATION,
    version: "1.0.0",
    manifest: integrationManifest("~1.0.0"),
  });
  await put(AGENT_PACKAGES_BUCKET, versionZipKey(INTEGRATION, "1.0.0"), {
    "manifest.json": JSON.stringify(integrationManifest("~1.0.0")),
    "INTEGRATION.md": "# doc",
  });
  await db.execute(sql`INSERT INTO package_version_dependencies
    (version_id, dep_scope, dep_name, dep_type, version_range)
    VALUES (${version.id}, '@t0054', 'srv', 'mcp-server', '~1.0.0')`);

  await seedPackage({ id: AGENT, orgId: org, type: "agent", draftManifest: agentManifest });
  await seedPackageVersion({ packageId: AGENT, version: "1.0.0", manifest: agentManifest });
  await put(AGENT_PACKAGES_BUCKET, versionZipKey(AGENT, "1.0.0"), {
    "manifest.json": JSON.stringify(agentManifest),
    "prompt.md": "hi",
  });
}

const draftManifestOf = async (id: string) =>
  (
    await one<{ m: Record<string, any> }>(
      sql`SELECT draft_manifest AS m FROM packages WHERE id = ${id}`,
    )
  ).m;
const versionOf = (id: string, version = "1.0.0") =>
  one<{ manifest: Record<string, any>; integrity: string; artifact_size: number }>(
    sql`SELECT manifest, integrity, artifact_size FROM package_versions
      WHERE package_id = ${id} AND version = ${version}`,
  );
const serverCount = async () =>
  (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM packages WHERE type = 'mcp-server'`))
    .n;

describe("0054 — mcp-server packages folded into their integrations", () => {
  beforeEach(async () => {
    await truncateAll();
    for (const [bucket, key] of keys.splice(0)) await deleteFile(bucket, key).catch(() => {});
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "t0054" });
    await seedAll();
  });

  it("a dry run reports and writes nothing", async () => {
    const before = await draftManifestOf(INTEGRATION);
    const fold = await run(false);
    expect(fold.integrationsFolded).toEqual([`${INTEGRATION} (draft)`, `${INTEGRATION}@1.0.0`]);
    expect(fold.dependenciesStripped).toContain(`${AGENT}@1.0.0`);
    expect(await serverCount()).toBe(3);
    expect(await draftManifestOf(INTEGRATION)).toEqual(before);
    const stored = unzipArtifact(
      new Uint8Array(
        (await downloadFile(AGENT_PACKAGES_BUCKET, versionZipKey(INTEGRATION, "1.0.0")))!,
      ),
    );
    expect(Object.keys(stored).sort()).toEqual(["INTEGRATION.md", "manifest.json"]);
    expect(lines.join("\n")).toContain("0054: DRY RUN");
  });

  it("folds draft and versions, the user_config bridge, payload and dependencies, then finds nothing", async () => {
    const fold = await run(true);

    const draft = await draftManifestOf(INTEGRATION);
    expect(draft.source.server).toEqual({
      type: "node",
      entry_point: "server/index.ts",
      mcp_config: { command: "bun", args: ["server/index.ts"], env: { LITERAL: "x" } },
      tools: [{ name: "do_it", description: "Does it" }],
    });
    expect(draft.auths.api.delivery.env).toEqual({
      API_TOKEN: { value: "{$credential.token}", sensitive: true },
      TOKEN: { value: "{$credential.token}", sensitive: true },
    });
    expect(draft._meta).toEqual({
      "dev.appstrate/mcp-server": { runtime: "bun" },
      "dev.appstrate/workspace": { mount: "rw" },
    });
    expect(draft.dependencies?.mcp_servers).toBeUndefined();
    expect(fold.notes.join("\n")).toContain("ORPHANED");
    expect(fold.unfolded).toEqual([]);

    const draftFiles = unzipArtifact(
      new Uint8Array(
        (await downloadFile(
          PACKAGE_ITEMS_BUCKET,
          packageItemKey("integrations", ctx.orgId, INTEGRATION),
        ))!,
      ),
    );
    // A draft folds the server's PUBLISHED version resolved by its pin (^1.0.0 → 1.1.0), not its draft.
    expect(dec.decode(draftFiles["server/index.ts"])).toBe("// v1.1.0");
    expect(JSON.parse(dec.decode(draftFiles["manifest.json"]))).toEqual(draft);
    expect(dec.decode(draftFiles["INTEGRATION.md"])).toBe("# doc");

    // The highest version satisfying `~1.0.0` is 1.0.0 (1.1.0 does not satisfy it).
    const version = await versionOf(INTEGRATION);
    const bytes = new Uint8Array(
      (await downloadFile(AGENT_PACKAGES_BUCKET, versionZipKey(INTEGRATION, "1.0.0")))!,
    );
    expect(version.integrity).toBe(computeIntegrity(bytes));
    expect(version.artifact_size).toBe(bytes.byteLength);
    const files = unzipArtifact(bytes);
    expect(dec.decode(files["server/index.ts"])).toBe("// v1.0.0");
    expect(JSON.parse(dec.decode(files["manifest.json"]))).toEqual(version.manifest);
    expect(version.manifest.source.server.tools).toHaveLength(1);

    // An agent only loses the dependency, archive and integrity following.
    expect((await draftManifestOf(AGENT)).dependencies).toEqual({ skills: {} });
    const agent = await versionOf(AGENT);
    expect(agent.manifest.dependencies).toEqual({ skills: {} });
    const agentBytes = new Uint8Array(
      (await downloadFile(AGENT_PACKAGES_BUCKET, versionZipKey(AGENT, "1.0.0")))!,
    );
    expect(agent.integrity).toBe(computeIntegrity(agentBytes));
    expect(Object.keys(unzipArtifact(agentBytes)).sort()).toEqual(["manifest.json", "prompt.md"]);

    // Servers are gone with their rows, orphans printed, system ones included.
    expect(fold.orphanServers).toEqual([{ id: ORPHAN, orgId: ctx.orgId }]);
    expect(lines.join("\n")).toContain(`orphan server ${ORPHAN}`);
    expect(fold.serversDeleted).toBe(3);
    expect(fold.systemServersDeleted).toBe(1);
    expect(await serverCount()).toBe(0);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM package_versions
        WHERE package_id IN (${SERVER}, ${SYSTEM_SERVER})`)
      ).n,
    ).toBe(0);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM package_dist_tags
        WHERE package_id = ${SERVER}`)
      ).n,
    ).toBe(0);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM space_packages
        WHERE package_id = ${SERVER}`)
      ).n,
    ).toBe(0);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM package_version_dependencies
        WHERE dep_type = 'mcp-server'`)
      ).n,
    ).toBe(0);
    expect(fold.dependencyRowsDeleted).toBe(1);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM storage_deletion_jobs
        WHERE reason = 'mcp_server_folded'`)
      ).n,
    ).toBe(fold.storageObjectsQueued);
    expect(fold.storageObjectsQueued).toBe(3 + 3);

    // A second apply writes nothing: same bytes, same integrity.
    const keyOf = versionZipKey(INTEGRATION, "1.0.0");
    const bytesBefore = Buffer.from((await downloadFile(AGENT_PACKAGES_BUCKET, keyOf))!);
    const again = await run(true);
    expect(
      Buffer.compare(bytesBefore, Buffer.from((await downloadFile(AGENT_PACKAGES_BUCKET, keyOf))!)),
    ).toBe(0);
    expect((await versionOf(INTEGRATION)).integrity).toBe(version.integrity);
    expect(again.integrationsFolded).toEqual([]);
    expect(again.dependenciesStripped).toEqual([]);
    expect(again.serversDeleted).toBe(0);
    expect(again.storageObjectsQueued).toBe(0);
    expect(await draftManifestOf(INTEGRATION)).toEqual(draft);
  });

  it("deletes system integration versions on the retired shape and re-points latest", async () => {
    const SYS = "@appstrate/t0054-sys-int";
    const old = { ...integrationManifest("^1.0.0"), name: SYS };
    const fresh = {
      name: SYS,
      version: "1.1.0",
      type: "integration",
      source: { kind: "local", server: { type: "node", entry_point: "server/index.ts" } },
    };
    await seedPackage({ id: SYS, orgId: null, type: "integration", source: "system" });
    const oldRow = await seedPackageVersion({ packageId: SYS, version: "1.0.3", manifest: old });
    const keep = await seedPackageVersion({ packageId: SYS, version: "1.0.2", manifest: fresh });
    await db.execute(sql`INSERT INTO package_version_dependencies
      (version_id, dep_scope, dep_name, dep_type, version_range)
      VALUES (${oldRow.id}, '@t0054', 'srv', 'skill', '*')`);
    await db.execute(sql`INSERT INTO package_dist_tags (package_id, tag, version_id)
      VALUES (${SYS}, 'latest', ${oldRow.id})`);

    await run(false);
    expect(
      (
        await one<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM package_versions WHERE package_id = ${SYS}`,
        )
      ).n,
    ).toBe(2);

    const fold = await run(true);
    expect(fold.systemVersionsDeleted).toEqual([`${SYS}@1.0.3`]);
    expect(fold.latestRepointed).toEqual([`${SYS} → 1.0.2`]);
    expect(
      toRows<{ version: string }>(
        await db.execute(sql`SELECT version FROM package_versions WHERE package_id = ${SYS}`),
      ).map((r) => r.version),
    ).toEqual(["1.0.2"]);
    expect(
      (
        await one<{ id: number }>(sql`SELECT version_id AS id FROM package_dist_tags
        WHERE package_id = ${SYS} AND tag = 'latest'`)
      ).id,
    ).toBe(keep.id);
    expect(
      (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM packages WHERE id = ${SYS}`)).n,
    ).toBe(1);
    expect((await run(true)).systemVersionsDeleted).toEqual([]);
  });

  it("removes stored mcp-servers:* grants from every permission column, and the package_shared notifications of a server", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      scopes: ["agents:read", "mcp-servers:read", "mcp-servers:write"],
    });
    const untouched = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      scopes: ["agents:read"],
    });
    const role = await seedSpaceRole({
      orgId: ctx.orgId,
      permissions: ["skills:read", "mcp-servers:read", "mcp-servers:share"],
    });
    await db.execute(sql`INSERT INTO oauth_clients (id, client_id, redirect_uris, scopes)
      VALUES ('t0054-client', 't0054-client', ARRAY['http://localhost/cb'],
        ARRAY['agents:read', 'mcp-servers:write'])`);
    await db.execute(sql`INSERT INTO device_codes (id, device_code, user_code, expires_at, status, scope)
      VALUES ('t0054-dc', 't0054-dc', 't0054-uc', now() + interval '1 hour', 'pending',
        'openid  mcp-servers:read agents:read'),
        ('t0054-dc2', 't0054-dc2', 't0054-uc2', now() + interval '1 hour', 'pending', 'openid')`);
    const notify = (type: string, packageType: string) =>
      db.execute(sql`INSERT INTO notifications (org_id, recipient_id, recipient_type, space_id, type, payload)
        VALUES (${ctx.orgId}, 't0054-user', 'user', ${ctx.defaultSpaceId}, ${type},
          ${JSON.stringify({ packageId: "@t0054/x", package_type: packageType })}::jsonb)`);
    await notify("package_shared", "mcp-server");
    await notify("package_shared", "skill");

    const fold = await run(true);
    expect(fold.grantsScrubbed).toMatchObject({
      "api_keys.scopes": 1,
      "oauth_clients.scopes": 1,
      "space_roles.permissions": 1,
      "device_codes.scope": 1,
      "oauth_access_tokens.scopes": 0,
      "cli_refresh_tokens.scope": 0,
    });
    expect(fold.notificationsDeleted).toBe(1);
    const scopes = async (id: string) =>
      (await one<{ scopes: string[] }>(sql`SELECT scopes FROM api_keys WHERE id = ${id}`)).scopes;
    expect(await scopes(key.id)).toEqual(["agents:read"]);
    expect(await scopes(untouched.id)).toEqual(["agents:read"]);
    expect(
      (
        await one<{ permissions: string[] }>(
          sql`SELECT permissions FROM space_roles WHERE id = ${role.id}`,
        )
      ).permissions,
    ).toEqual(["skills:read"]);
    expect(
      (
        await one<{ scopes: string[] }>(
          sql`SELECT scopes FROM oauth_clients WHERE id = 't0054-client'`,
        )
      ).scopes,
    ).toEqual(["agents:read"]);
    const deviceScope = async (id: string) =>
      (await one<{ scope: string }>(sql`SELECT scope FROM device_codes WHERE id = ${id}`)).scope;
    expect(await deviceScope("t0054-dc")).toBe("openid agents:read");
    expect(await deviceScope("t0054-dc2")).toBe("openid");
    expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications`)).n).toBe(1);
    const again = await run(true);
    expect(Object.values(again.grantsScrubbed).every((n) => n === 0)).toBe(true);
    expect(again.notificationsDeleted).toBe(0);
  });

  it("the release migration 0106 fails while a server remains, and passes once folded", async () => {
    const statements = await migration0106();
    const apply0106 = () =>
      db.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(sql.raw(statement));
        throw new Error("rolled back on purpose");
      });
    // drizzle wraps the driver error: the refused cast is in its cause.
    const refusal = await apply0106().catch((error: Error) => error);
    expect(String((refusal as Error).cause)).toContain("mcp-server");
    await run(true);
    await expect(apply0106()).rejects.toThrow("rolled back on purpose");
  });
});

// ─── Resolution, refusal, bridge ────────────────────────────────────────────

const S2 = "@t0054/s2";
const I2 = "@t0054/i2";

const refManifest = (pin: string | undefined, delivery?: object) => ({
  name: I2,
  version: "1.0.0",
  type: "integration",
  source: { kind: "local", server: pin === undefined ? { name: S2 } : { name: S2, version: pin } },
  auths: {
    api: {
      type: "api_key",
      delivery: {
        env: delivery ?? {
          API_TOKEN: { value: "{$credential.token}", sensitive: true, user_config_key: "token" },
        },
      },
    },
  },
});
const srv2 = (version: string) => ({
  name: S2,
  version,
  type: "mcp-server",
  server: { type: "node", entry_point: "server/index.ts", mcp_config: { command: "bun" } },
  tools: [{ name: `tool_${version}`, description: "x" }],
});

interface Srv2Version {
  version: string;
  yanked?: boolean;
  /** `null`: the archive is missing from storage. */
  files?: Record<string, string> | null;
}
async function mkServer(
  orgId: string | null,
  versions: Srv2Version[],
  tags: Record<string, string> = {},
  draft?: { files: Record<string, string> | null },
) {
  await seedServer(S2, orgId, srv2("9.9.9"), orgId === null ? null : ctx.defaultSpaceId);
  if (draft?.files) await put(PACKAGE_ITEMS_BUCKET, `${orgId}/mcp-servers/${S2}.afps`, draft.files);
  for (const v of versions) {
    await db.execute(sql`INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest, yanked)
      VALUES (${S2}, ${v.version}, 'sha256-x', 1, ${JSON.stringify(srv2(v.version))}::jsonb, ${v.yanked === true})`);
    if (v.files !== null) {
      await put(
        AGENT_PACKAGES_BUCKET,
        versionZipKey(S2, v.version),
        v.files ?? { "manifest.json": "{}", "server/index.ts": `// ${v.version}` },
      );
    }
  }
  for (const [tag, version] of Object.entries(tags)) {
    await db.execute(sql`INSERT INTO package_dist_tags (package_id, tag, version_id)
      SELECT package_id, ${tag}, id FROM package_versions WHERE package_id = ${S2} AND version = ${version}`);
  }
}
async function mkIntegration(
  pin: string | undefined,
  opts: { draft?: boolean; version?: boolean; files?: Record<string, string> } = {},
) {
  const own = { "manifest.json": "{}", "INTEGRATION.md": "# doc", ...opts.files };
  await seedPackage({
    id: I2,
    orgId: ctx.orgId,
    type: "integration",
    ...(opts.draft ? { draftManifest: refManifest(pin) } : {}),
  });
  if (opts.draft) {
    await put(PACKAGE_ITEMS_BUCKET, packageItemKey("integrations", ctx.orgId, I2), own);
  }
  if (opts.version ?? true) {
    await seedPackageVersion({ packageId: I2, version: "1.0.0", manifest: refManifest(pin) });
    await put(AGENT_PACKAGES_BUCKET, versionZipKey(I2, "1.0.0"), own);
  }
}
const storedBytes = async (bucket: string, key: string) =>
  Buffer.from((await downloadFile(bucket, key))!);
const toolOf = async (id: string) =>
  ((await versionOf(id)).manifest.source.server.tools as Array<{ name: string }>)[0]!.name;
const deletionJobs = async () =>
  (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM storage_deletion_jobs`)).n;

describe("0054 — resolution as the runtime did, refusal, bridge", () => {
  beforeEach(async () => {
    await truncateAll();
    for (const [bucket, key] of keys.splice(0)) await deleteFile(bucket, key).catch(() => {});
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "t0054" });
  });

  it("--apply refuses and writes nothing while a server archive is missing", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0", files: null }, { version: "1.1.0" }]);
    await mkIntegration("1.0.0");
    const key = versionZipKey(I2, "1.0.0");
    const before = await storedBytes(AGENT_PACKAGES_BUCKET, key);
    const manifestBefore = (await versionOf(I2)).manifest;

    const dry = await run(false);
    expect(dry.unfolded.join("\n")).toContain(`archive of ${S2}@1.0.0 missing`);
    expect(lines.join("\n")).toContain("--apply would refuse");

    const fold = await run(true);
    expect(fold.refused).toBe(true);
    expect(lines.join("\n")).toContain("0054: REFUSED");
    expect(await serverCount()).toBe(1);
    expect((await versionOf(I2)).manifest).toEqual(manifestBefore);
    expect(Buffer.compare(before, await storedBytes(AGENT_PACKAGES_BUCKET, key))).toBe(0);
    expect(await deletionJobs()).toBe(0);
  });

  it("exits before planning when no server archive is readable", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0", files: null }]);
    await mkIntegration("1.0.0");
    await expect(run(true)).rejects.toBeInstanceOf(StorageUnreadable);
    // The storage target is printed before the refusal, whichever backend the tier runs on.
    expect(lines.join("\n")).toMatch(/^storage: (filesystem|s3 bucket) /m);
    expect(await serverCount()).toBe(1);
  });

  it("a missing pin resolves the latest dist-tag, not the highest version", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0" }, { version: "2.0.0" }], { latest: "1.0.0" });
    await mkIntegration(undefined);
    await run(true);
    expect(await toolOf(I2)).toBe("tool_1.0.0");
  });

  it("a pin that is a dist-tag name resolves through the tag", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0" }, { version: "2.0.0" }], { beta: "1.0.0" });
    await mkIntegration("beta");
    await run(true);
    expect(await toolOf(I2)).toBe("tool_1.0.0");
  });

  it("an exact pin on a yanked version resolves it while live versions exist; a range skips it", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0", yanked: true }, { version: "1.1.0" }]);
    await mkIntegration("1.0.0");
    await run(true);
    expect(await toolOf(I2)).toBe("tool_1.0.0");
  });

  it("a range pin never picks a yanked version", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0" }, { version: "1.1.0", yanked: true }]);
    await mkIntegration("^1.0.0");
    await run(true);
    expect(await toolOf(I2)).toBe("tool_1.0.0");
  });

  it("an org integration referencing a SYSTEM server takes its highest version whatever the pin", async () => {
    await mkServer(null, [{ version: "1.0.0" }, { version: "2.0.0" }]);
    await mkIntegration("^1.0.0");
    await run(true);
    expect(await toolOf(I2)).toBe("tool_2.0.0");
  });

  it("a draft folds the published version its pin resolves, not the server's edited draft", async () => {
    await mkServer(
      ctx.orgId,
      [{ version: "1.0.0" }],
      {},
      { files: { "server/index.ts": "// draft" } },
    );
    await mkIntegration("^1.0.0", { draft: true, version: false });
    await run(true);
    const draft = await draftManifestOf(I2);
    expect(draft.source.server.tools[0].name).toBe("tool_1.0.0");
    const files = unzipArtifact(
      new Uint8Array(
        (await downloadFile(PACKAGE_ITEMS_BUCKET, packageItemKey("integrations", ctx.orgId, I2)))!,
      ),
    );
    expect(dec.decode(files["server/index.ts"])).toBe("// 1.0.0");
  });

  it("a server never published folds its draft, and refuses when the draft payload is missing", async () => {
    await mkServer(ctx.orgId, [], {}, { files: null });
    await mkIntegration("*", { draft: true, version: false });
    const refused = await run(true);
    expect(refused.refused).toBe(true);
    expect(refused.unfolded.join("\n")).toContain("draft payload");
    expect(await serverCount()).toBe(1);
    expect((await draftManifestOf(I2)).source.server).toEqual({ name: S2, version: "*" });

    await put(PACKAGE_ITEMS_BUCKET, `${ctx.orgId}/mcp-servers/${S2}.afps`, {
      "manifest.json": "{}",
      "server/index.ts": "// draft",
    });
    const ok = await run(true);
    expect(ok.refused).toBe(false);
    expect((await draftManifestOf(I2)).source.server.tools[0].name).toBe("tool_9.9.9");
  });

  it("a path in both with different bytes is unfolded, with identical bytes it folds", async () => {
    await mkServer(ctx.orgId, [{ version: "1.0.0" }]);
    await mkIntegration("1.0.0", { files: { "server/index.ts": "// mine" } });
    const refused = await run(true);
    expect(refused.refused).toBe(true);
    expect(refused.unfolded.join("\n")).toContain("server/index.ts exists in both with different");
    expect(await serverCount()).toBe(1);

    await truncateAll();
    ctx = await createTestContext({ orgSlug: "t0054" });
    await mkServer(ctx.orgId, [{ version: "1.0.0" }]);
    await mkIntegration("1.0.0", { files: { "server/index.ts": "// 1.0.0" } });
    const ok = await run(true);
    expect(ok.refused).toBe(false);
    expect(ok.notes.join("\n")).toContain("server/index.ts exists in both, identical");
    expect(await serverCount()).toBe(0);
  });
});

describe("0054 — the ${user_config.K} bridge", () => {
  const integration = (delivery: object) => refManifest("*", delivery) as Record<string, any>;
  const server = (env: Record<string, string>) => ({
    ...srv2("1.0.0"),
    server: { type: "node", entry_point: "x", mcp_config: { command: "bun", env } },
  });
  const delivered = (m: Record<string, any>) => m.auths.api.delivery.env;
  const TOKEN = { value: "{$credential.token}", sensitive: true, user_config_key: "token" };

  it("an embedded placeholder becomes a delivery template, sensitive when a matched entry is", () => {
    const fold = foldLocalIntegrationManifest(
      integration({ API_TOKEN: TOKEN }),
      server({ AUTH: "Bearer ${user_config.token}" }),
    );
    expect(fold.unfolded).toEqual([]);
    expect(delivered(fold.manifest).AUTH).toEqual({
      value: "Bearer {$credential.token}",
      sensitive: true,
    });
    expect((fold.manifest.source as any).server.mcp_config.env).toBeUndefined();
  });

  it("several placeholders in one value are all replaced", () => {
    const fold = foldLocalIntegrationManifest(
      integration({ A: { value: "{$credential.a}", user_config_key: "a" }, B: TOKEN }),
      server({ BOTH: "${user_config.a}:${user_config.token}" }),
    );
    expect(delivered(fold.manifest).BOTH).toEqual({
      value: "{$credential.a}:{$credential.token}",
      sensitive: true,
    });
  });

  it("an embedded placeholder with no matching entry is unfolded, a whole-value one is dropped with a note", () => {
    const embedded = foldLocalIntegrationManifest(
      integration({ API_TOKEN: TOKEN }),
      server({ AUTH: "Bearer ${user_config.nowhere}" }),
    );
    expect(embedded.unfolded.join("\n")).toContain("AUTH");
    const whole = foldLocalIntegrationManifest(
      integration({ API_TOKEN: TOKEN }),
      server({ AUTH: "${user_config.nowhere}" }),
    );
    expect(whole.unfolded).toEqual([]);
    expect(whole.notes.join("\n")).toContain("AUTH");
    expect(delivered(whole.manifest).AUTH).toBeUndefined();
  });

  it("an existing delivery.env[V] is never overwritten", () => {
    const fold = foldLocalIntegrationManifest(
      integration({ API_TOKEN: TOKEN, AUTH: { value: "mine" } }),
      server({ AUTH: "Bearer ${user_config.token}" }),
    );
    expect(delivered(fold.manifest).AUTH).toEqual({ value: "mine" });
    expect(fold.notes.join("\n")).toContain("already set");
  });
});
