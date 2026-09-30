// SPDX-License-Identifier: Apache-2.0

/**
 * #1612 — a package key names an id, not an incarnation. A package deleted then
 * recreated under the same id (or a version deleted then republished) writes the
 * key a pending storage-deletion job still targets; the worker must keep what a
 * live row claims and still purge what nothing claims.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db, isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import { packages, storageDeletionJobs } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { ifMatch } from "../../helpers/etag.ts";
import { truncateAll } from "../../helpers/db.ts";
import { processStorageDeletionJobs } from "../../../src/services/storage-deletion.ts";
import {
  PACKAGE_ITEMS_BUCKET,
  packageItemKey,
  CONFIG_BY_TYPE,
} from "../../../src/services/package-items/config.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
import { deleteVersionZip } from "../../../src/services/package-storage.ts";
import { createOrgItem } from "../../../src/services/package-items/crud.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { withPackageDraftLock } from "../../../src/services/package-locks.ts";
import { forkPackage } from "../../../src/services/package-fork.ts";

const app = getTestApp();
const ID = "@reclaim/skill";
const SKILL_MD = "---\nname: skill\ndescription: Reclaim test\n---\n\nInstructions";
// Each case chains several real creates, publishes and deletes against storage.
const TIMEOUT_MS = 30_000;

describe("package storage keys reclaimed by a live row (#1612)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reclaim" });
  });

  const draftKey = (folder: "skills" | "agents" = "skills", id = ID) =>
    packageItemKey(folder, ctx.orgId, id);

  function createSkill(opts: { id?: string; annex?: string; as?: TestContext } = {}) {
    const id = opts.id ?? ID;
    return app.request("/api/packages/skills", {
      method: "POST",
      headers: authHeaders(opts.as ?? ctx),
      body: JSON.stringify({
        manifest: {
          name: id,
          type: "skill",
          schema_version: "0.2",
          version: "1.0.0",
          display_name: "Reclaim",
          description: "Reclaim test",
        },
        content: SKILL_MD,
        operations: [
          { op: "write", path: "notes.txt", text: opts.annex ?? "annex" },
          { op: "write", path: "binary.bin", bytes_base64: "AP+A" },
        ],
      }),
    });
  }

  async function deletePackage(id = ID, type = "skills") {
    const res = await app.request(`/api/packages/${type}/${id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(204);
  }

  async function writeNotes(text: string) {
    const [row] = await db
      .select({ lockVersion: packages.lockVersion })
      .from(packages)
      .where(eq(packages.id, ID));
    const res = await app.request(`/api/packages/skills/${ID}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ctx),
        "Content-Type": "application/json",
        ...ifMatch(row!.lockVersion),
      },
      body: JSON.stringify({ operations: [{ op: "write", path: "notes.txt", text }] }),
    });
    expect(res.status).toBe(200);
  }

  function publish(version: string) {
    return app.request(`/api/packages/skills/${ID}/versions`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ version }),
    });
  }

  async function draftPaths(): Promise<string[]> {
    const res = await app.request(`/api/packages/${ID}/files?version=draft`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { path: string }[] }).data.map((e) => e.path).sort();
  }

  const downloadStatus = async (version: string, id = ID) =>
    (await app.request(`/api/packages/${id}/${version}/download`, { headers: authHeaders(ctx) }))
      .status;

  const pendingJobs = () =>
    db
      .select({ bucket: storageDeletionJobs.bucket, storageKey: storageDeletionJobs.storageKey })
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));

  const exists = (bucket: string, key: string) => storage.fileExists(bucket, key);

  const FULL_DRAFT = ["SKILL.md", "binary.bin", "manifest.json", "notes.txt"];

  it(
    "keeps a package recreated under the same id before the worker ran",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await deletePackage();
      expect(await pendingJobs()).toHaveLength(2);

      expect((await createSkill({ annex: "second life" })).status).toBe(201);
      const pass = await processStorageDeletionJobs();

      expect(pass).toMatchObject({ claimed: 2, completed: 2, reclaimed: 2, failed: 0 });
      expect(await pendingJobs()).toEqual([]);
      expect(await draftPaths()).toEqual(FULL_DRAFT);
      const notes = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, draftKey());
      expect(notes).not.toBeNull();
      expect(await downloadStatus("1.0.0")).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    "still purges both objects when nothing takes the id back",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await deletePackage();

      const pass = await processStorageDeletionJobs();

      expect(pass).toMatchObject({ claimed: 2, completed: 2, reclaimed: 0, failed: 0 });
      expect(await exists(PACKAGE_ITEMS_BUCKET, draftKey())).toBe(false);
      expect(await exists(AGENT_PACKAGES_BUCKET, versionZipKey(ID, "1.0.0"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a version republished under a deleted version's number",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await writeNotes("v2");
      expect((await publish("1.0.1")).status).toBe(201);
      const del = await app.request(`/api/packages/skills/${ID}/versions/1.0.1`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);

      await writeNotes("v2, again");
      expect((await publish("1.0.1")).status).toBe(201);
      const pass = await processStorageDeletionJobs();

      expect(pass).toMatchObject({ claimed: 1, reclaimed: 1, failed: 0 });
      expect(await downloadStatus("1.0.1")).toBe(200);
      expect(await downloadStatus("1.0.0")).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    "still purges a deleted version nobody republished",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await writeNotes("v2");
      expect((await publish("1.0.1")).status).toBe(201);
      await app.request(`/api/packages/skills/${ID}/versions/1.0.1`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(await processStorageDeletionJobs()).toMatchObject({ reclaimed: 0, completed: 1 });
      expect(await exists(AGENT_PACKAGES_BUCKET, versionZipKey(ID, "1.0.1"))).toBe(false);
      expect(await downloadStatus("1.0.0")).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    "matches the exact key: a successor of another type does not shield the old draft",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await deletePackage();

      const agent = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx),
        body: JSON.stringify({
          manifest: {
            name: ID,
            type: "agent",
            schema_version: "0.2",
            version: "1.0.0",
            display_name: "Reclaim agent",
            description: "Same id, other type",
          },
          content: "Instructions",
        }),
      });
      expect(agent.status, await agent.clone().text()).toBe(201);

      const pass = await processStorageDeletionJobs();

      // The skill's draft (skills/ folder) is dead; the version key is the
      // agent's own 1.0.0 now.
      expect(pass).toMatchObject({ claimed: 2, reclaimed: 1, failed: 0 });
      expect(await exists(PACKAGE_ITEMS_BUCKET, draftKey("skills"))).toBe(false);
      expect(await exists(PACKAGE_ITEMS_BUCKET, draftKey("agents"))).toBe(true);
      expect(await downloadStatus("1.0.0")).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a fork minted under the id of a deleted package",
    async () => {
      const other = await createTestContext({ orgSlug: "reclaim-src" });
      expect((await createSkill({ id: "@reclaim-src/skill", as: other })).status).toBe(201);
      expect((await createSkill({ annex: "doomed" })).status).toBe(201);
      await deletePackage();

      const fork = await forkPackage(
        ctx.orgId,
        "reclaim",
        "@reclaim-src/skill",
        ctx.defaultSpaceId,
        ctx.user.id,
      );
      expect(fork).toMatchObject({ packageId: ID });

      expect(await processStorageDeletionJobs()).toMatchObject({ reclaimed: 2, failed: 0 });
      expect(await draftPaths()).toEqual(FULL_DRAFT);
      expect(await downloadStatus("1.0.0")).toBe(200);
    },
    TIMEOUT_MS,
  );

  it(
    "deleteVersionZip keeps the artifact of a committed version and removes an orphan",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await deleteVersionZip(ID, "1.0.0");
      expect(await exists(AGENT_PACKAGES_BUCKET, versionZipKey(ID, "1.0.0"))).toBe(true);

      await storage.uploadFile(
        AGENT_PACKAGES_BUCKET,
        versionZipKey(ID, "9.9.9"),
        new Uint8Array([1]),
      );
      await deleteVersionZip(ID, "9.9.9");
      expect(await exists(AGENT_PACKAGES_BUCKET, versionZipKey(ID, "9.9.9"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  // ── Races: only a real PostgreSQL has concurrent connections ──────────────

  /** Wait until some session is blocked on the draft lock of {@link ID}. */
  async function untilDraftLockWaiter(
    connection: NonNullable<Awaited<ReturnType<typeof reservePgConnection>>>,
  ): Promise<boolean> {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const rows =
        await connection.sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext(${`package-files:${ID}`})::bigint & 4294967295)`;
      if (rows.length) return true;
      await Bun.sleep(10);
    }
    return false;
  }

  /** A worker pass held inside the physical delete of {@link ID}'s old draft. */
  function workerPausedOnDraftDelete() {
    const deleting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pass = processStorageDeletionJobs({
      deleteFile: async (bucket, key) => {
        if (bucket === PACKAGE_ITEMS_BUCKET) {
          deleting.resolve();
          await release.promise;
        }
        await storage.deleteFile(bucket, key);
      },
    });
    return { pass, deleting: deleting.promise, release: () => release.resolve() };
  }

  it.skipIf(isEmbeddedDb)(
    "a worker pass waits for a successor still uploading, then keeps its bytes",
    async () => {
      expect((await createSkill()).status).toBe(201);
      await deletePackage();
      const connection = (await reservePgConnection())!;
      const uploaded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      // `createPackageDraft`, held open between its upload and its commit.
      const successor = withPackageDraftLock(ID, async (tx) => {
        await createOrgItem(
          ctx.orgId,
          { id: ID, content: SKILL_MD, homeSpaceId: ctx.defaultSpaceId },
          CONFIG_BY_TYPE.skill,
          {
            name: ID,
            type: "skill",
            schema_version: "0.2",
            version: "1.0.0",
            description: "Reclaim test",
          },
          undefined,
          tx,
        );
        await uploadPackageFiles("skills", ctx.orgId, ID, {
          "SKILL.md": new TextEncoder().encode(SKILL_MD),
          "notes.txt": new TextEncoder().encode("successor"),
        });
        uploaded.resolve();
        await release.promise;
      });
      let pass: ReturnType<typeof processStorageDeletionJobs> | undefined;
      try {
        await uploaded.promise;
        pass = processStorageDeletionJobs();
        expect(await untilDraftLockWaiter(connection)).toBe(true);
        expect(await exists(PACKAGE_ITEMS_BUCKET, draftKey())).toBe(true);
        release.resolve();
        await successor;
        expect((await pass).failed).toBe(0);
        const files = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, draftKey());
        expect(files).not.toBeNull();
      } finally {
        release.resolve();
        await successor.catch(() => {});
        await pass?.catch(() => {});
        connection.release();
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(isEmbeddedDb)(
    "a recreation waits for an in-flight purge of the old bytes, then writes its own",
    async () => {
      expect((await createSkill({ annex: "old" })).status).toBe(201);
      await deletePackage();
      const connection = (await reservePgConnection())!;
      const { pass, deleting, release } = workerPausedOnDraftDelete();
      let recreation: Promise<Response> | undefined;
      try {
        await deleting;
        recreation = Promise.resolve(createSkill({ annex: "new" }));
        expect(await untilDraftLockWaiter(connection)).toBe(true);
        release();
        expect((await pass).failed).toBe(0);
        expect((await recreation).status).toBe(201);

        const notes = await app.request(`/api/packages/${ID}/files/content?path=notes.txt`, {
          headers: authHeaders(ctx),
        });
        expect(notes.status).toBe(200);
        expect(await notes.text()).toBe("new");
        expect(await draftPaths()).toEqual(FULL_DRAFT);
        expect(await downloadStatus("1.0.0")).toBe(200);
        const [job] = await db
          .select()
          .from(storageDeletionJobs)
          .where(
            and(
              eq(storageDeletionJobs.bucket, AGENT_PACKAGES_BUCKET),
              eq(storageDeletionJobs.storageKey, versionZipKey(ID, "1.0.0")),
            ),
          );
        expect(job?.completedAt).not.toBeNull();
      } finally {
        release();
        await pass.catch(() => {});
        await recreation?.catch(() => {});
        connection.release();
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(isEmbeddedDb)(
    "a fork waits for an in-flight purge of the old bytes, then writes its own",
    async () => {
      const other = await createTestContext({ orgSlug: "reclaim-src" });
      expect((await createSkill({ id: "@reclaim-src/skill", as: other })).status).toBe(201);
      expect((await createSkill({ annex: "doomed" })).status).toBe(201);
      await deletePackage();
      const connection = (await reservePgConnection())!;
      const { pass, deleting, release } = workerPausedOnDraftDelete();
      let fork: ReturnType<typeof forkPackage> | undefined;
      try {
        await deleting;
        fork = forkPackage(ctx.orgId, "reclaim", "@reclaim-src/skill", ctx.defaultSpaceId);
        expect(await untilDraftLockWaiter(connection)).toBe(true);
        release();
        expect((await pass).failed).toBe(0);
        expect(await fork).toMatchObject({ packageId: ID });
        expect(await draftPaths()).toEqual(FULL_DRAFT);
      } finally {
        release();
        await pass.catch(() => {});
        await fork?.catch(() => {});
        connection.release();
      }
    },
    TIMEOUT_MS,
  );
});
