// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db, isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  computeHasUnpublishedChanges,
  createVersionFromDraft,
  getLatestVersionCreatedAt,
} from "../../../src/services/package-versions.ts";
import { downloadVersionZip } from "../../../src/services/package-storage.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { mutatePackageDraftFiles } from "../../../src/services/package-files.ts";
import { unzipPackageArchive } from "../../../src/services/package-archive.ts";

const id = "@draft-publish/agent";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const manifest = { name: id, type: "agent", version: "1.0.0", description: "OLD" };

describe("publishing a coherent package draft", () => {
  let ctx: TestContext;
  let lockVersion: number;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "draft-publish" });
    const pkg = await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "agent",
      createdBy: ctx.user.id,
      draftManifest: manifest,
      draftContent: "OLD prompt",
    });
    lockVersion = pkg.lockVersion;
    await uploadPackageFiles("agents", ctx.orgId, id, {
      "prompt.md": encoder.encode("OLD prompt"),
      "script.py": encoder.encode("OLD script"),
    });
  });

  const row = async () => (await db.select().from(packages).where(eq(packages.id, id)))[0]!;

  async function hasUnpublishedChanges() {
    const draft = await row();
    return computeHasUnpublishedChanges(
      draft.source,
      1,
      draft.updatedAt,
      await getLatestVersionCreatedAt(id),
    );
  }

  async function edit(version = "1.0.0") {
    await mutatePackageDraftFiles(
      { id, type: "agent", orgId: ctx.orgId },
      {
        precondition: { lockVersion },
        manifest: { ...manifest, version, description: "NEW" },
        mutate: (files) => ({
          ...files,
          "prompt.md": encoder.encode("NEW prompt"),
          "script.py": encoder.encode("NEW script"),
        }),
      },
    );
  }

  it("freezes the validated snapshot when an edit finishes during asynchronous validation", async () => {
    const result = await createVersionFromDraft({
      packageId: id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      validateManifest: async (captured) => {
        expect(captured.description).toBe("OLD");
        await edit();
      },
    });
    expect(result).toHaveProperty("version", "1.0.0");
    const zip = await downloadVersionZip(id, "1.0.0");
    const files = unzipPackageArchive(zip!);
    expect(JSON.parse(decoder.decode(files["manifest.json"])).description).toBe("OLD");
    expect(decoder.decode(files["prompt.md"])).toBe("OLD prompt");
    expect(decoder.decode(files["script.py"])).toBe("OLD script");
    expect((await row()).draftContent).toBe("NEW prompt");
    expect(await hasUnpublishedChanges()).toBe(true);
  });

  it("invalidates an editor's token when a successful publish changes the draft version", async () => {
    const result = await createVersionFromDraft({
      packageId: id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      version: "2.0.0",
    });
    expect(result).toHaveProperty("version", "2.0.0");
    const updated = await row();
    expect(updated.draftManifest).toMatchObject({ version: "2.0.0" });
    expect(updated.lockVersion).toBe(lockVersion + 1);
    expect(await hasUnpublishedChanges()).toBe(false);
    await expect(edit()).rejects.toThrow("modified concurrently");
  });

  it("keeps the draft untouched when the captured manifest fails validation", async () => {
    await expect(
      createVersionFromDraft({
        packageId: id,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        version: "2.0.0",
        validateManifest: async () => {
          throw new Error("Rejected manifest");
        },
      }),
    ).rejects.toThrow("Rejected manifest");
    expect((await row()).draftManifest).toEqual(manifest);
    expect((await row()).lockVersion).toBe(lockVersion);
  });

  it("does not overwrite a newer draft when synchronizing a published version override", async () => {
    const result = await createVersionFromDraft({
      packageId: id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      version: "2.0.0",
      validateManifest: async () => {
        await edit("3.0.0");
      },
    });
    expect(result).toHaveProperty("version", "2.0.0");
    expect((await row()).draftManifest).toMatchObject({ version: "3.0.0", description: "NEW" });
    expect((await row()).lockVersion).toBe(lockVersion + 1);
    expect(await hasUnpublishedChanges()).toBe(true);
  });

  it.skipIf(isEmbeddedDb)(
    "keeps a newer published draft clean when an older publication finalizes late",
    async () => {
      const capturedA = Promise.withResolvers<void>();
      const capturedB = Promise.withResolvers<void>();
      const resumeA = Promise.withResolvers<void>();
      const resumeB = Promise.withResolvers<void>();
      const publish = (captured: typeof capturedA, resume: typeof resumeA) =>
        createVersionFromDraft({
          packageId: id,
          orgId: ctx.orgId,
          userId: ctx.user.id,
          validateManifest: async () => {
            captured.resolve();
            await resume.promise;
          },
        });
      const connection = (await reservePgConnection())!;
      const publishingA = publish(capturedA, resumeA);
      let publishingB: ReturnType<typeof createVersionFromDraft> | undefined;
      try {
        await capturedA.promise;
        await edit("2.0.0");
        publishingB = publish(capturedB, resumeB);
        await capturedB.promise;

        // Allow both immutable versions to commit, but hold both finalizations.
        await connection.sql`BEGIN`;
        await connection.sql`SELECT pg_advisory_xact_lock(hashtext(${`package-files:${id}`})::bigint)`;
        const waitForVersion = async (version: string) => {
          const until = Date.now() + 3_000;
          while (Date.now() < until) {
            const rows = await connection.sql`SELECT id FROM package_versions
              WHERE package_id = ${id} AND version = ${version}`;
            if (rows.length > 0) return true;
            await Bun.sleep(10);
          }
          return false;
        };
        resumeA.resolve();
        expect(await waitForVersion("1.0.0")).toBe(true);
        resumeB.resolve();
        expect(await waitForVersion("2.0.0")).toBe(true);
        await connection.sql`COMMIT`;

        expect(await publishingA).toHaveProperty("version", "1.0.0");
        expect(await publishingB).toHaveProperty("version", "2.0.0");
        expect((await row()).draftManifest).toMatchObject({ version: "2.0.0", description: "NEW" });
        expect(await hasUnpublishedChanges()).toBe(false);
      } finally {
        resumeA.resolve();
        resumeB.resolve();
        await connection.sql`ROLLBACK`;
        connection.release();
        await Promise.allSettled([publishingA, publishingB]);
      }
    },
  );

  it.skipIf(isEmbeddedDb)(
    "waits for the writer's PostgreSQL lock before reading either store",
    async () => {
      const connection = (await reservePgConnection())!;
      const lockKey = `package-files:${id}`;
      let publishing: ReturnType<typeof createVersionFromDraft> | undefined;
      try {
        await connection.sql`BEGIN`;
        await connection.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
        await connection.sql`UPDATE packages SET
        draft_manifest = ${JSON.stringify({ ...manifest, description: "NEW" })}::jsonb,
        draft_content = 'NEW prompt', lock_version = lock_version + 1
        WHERE id = ${id} AND org_id = ${ctx.orgId}`;
        await uploadPackageFiles("agents", ctx.orgId, id, {
          "prompt.md": encoder.encode("NEW prompt"),
          "script.py": encoder.encode("NEW script"),
        });
        publishing = createVersionFromDraft({
          packageId: id,
          orgId: ctx.orgId,
          userId: ctx.user.id,
        });

        // Observe the real waiter, rather than guessing whether a sleep was long
        // enough for publication to reach the critical section.
        const waiting = async () => {
          const until = Date.now() + 3_000;
          while (Date.now() < until) {
            const [state] = await connection.sql<{ blocked: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND objid = (hashtext(${lockKey})::bigint & 4294967295)::oid
          ) AS blocked`;
            if (state!.blocked) return "waiting";
            await Bun.sleep(10);
          }
          return "no waiter";
        };
        expect(await Promise.race([waiting(), publishing.then(() => "published too early")])).toBe(
          "waiting",
        );
        await connection.sql`COMMIT`;
        expect(await publishing).toHaveProperty("version", "1.0.0");
        const files = unzipPackageArchive((await downloadVersionZip(id, "1.0.0"))!);
        expect(JSON.parse(decoder.decode(files["manifest.json"])).description).toBe("NEW");
        expect(decoder.decode(files["prompt.md"])).toBe("NEW prompt");
        expect(decoder.decode(files["script.py"])).toBe("NEW script");
      } finally {
        await connection.sql`ROLLBACK`;
        connection.release();
        await publishing?.catch(() => {});
      }
    },
  );
});
