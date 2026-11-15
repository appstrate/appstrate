// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0054` against the test database and the filesystem storage of tier 0: a local
 * integration's draft and versions take their referenced mcp-server's `server` block, tools, `_meta`
 * and payload files, the `${user_config.K}` bridge becomes `delivery.env` entries, an agent loses
 * `dependencies.mcp_servers`, every `mcp-server` package (orphans and system ones included) is
 * deleted, a dry run writes nothing and a second `--apply` finds nothing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import { deleteFile, downloadFile, uploadFile } from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import { runFoldMcpServers } from "../migration/0054-fold-mcp-servers.ts";
import { assertMcpServersFolded, unfoldedMcpServerCount } from "../../apps/api/src/lib/boot.ts";
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
import { seedPackage, seedPackageVersion } from "../../apps/api/test/helpers/seed.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SERVER = "@t0054/srv";
const ORPHAN = "@t0054/orphan";
const SYSTEM_SERVER = "@appstrate/t0054-system-srv";
const INTEGRATION = "@t0054/int";
const AGENT = "@t0054/agent";

const lines: string[] = [];
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
const serverCount = async () => unfoldedMcpServerCount();

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
    expect(fold.unresolved.join("\n")).toContain("ORPHANED");

    const draftFiles = unzipArtifact(
      new Uint8Array(
        (await downloadFile(
          PACKAGE_ITEMS_BUCKET,
          packageItemKey("integrations", ctx.orgId, INTEGRATION),
        ))!,
      ),
    );
    expect(dec.decode(draftFiles["server/index.ts"])).toBe("// draft");
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

    // The guard passes, and a second apply writes nothing.
    expect(await assertMcpServersFolded(null)).toBeUndefined();
    const again = await run(true);
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

  it("the guard refuses while a server remains, naming the script", async () => {
    await expect(assertMcpServersFolded(null)).rejects.toThrow(/0054-fold-mcp-servers\.ts --apply/);
    await run(true);
    expect(await assertMcpServersFolded(null)).toBeUndefined();
  });
});

describe("assertMcpServersFolded — injected count", () => {
  it("returns on zero, refuses naming the count and the embedded directory", async () => {
    expect(await assertMcpServersFolded(null, async () => 0)).toBeUndefined();
    await expect(assertMcpServersFolded(null, async () => 2)).rejects.toThrow(
      /holds 2 row\(s\)[\s\S]*Refusing to boot[\s\S]*0054-fold-mcp-servers\.ts --apply`, with this DATABASE_URL/,
    );
    await expect(assertMcpServersFolded("/srv/pglite", async () => 1)).rejects.toThrow(
      "`PGLITE_DATA_DIR=/srv/pglite bun scripts/migration/0054-fold-mcp-servers.ts` (dry run), then the same with `--apply`",
    );
  });

  it("propagates a failing probe", async () => {
    const boom = new Error("connection terminated");
    await expect(assertMcpServersFolded(null, () => Promise.reject(boom))).rejects.toThrow(boom);
  });
});
