// SPDX-License-Identifier: Apache-2.0

/**
 * The two PACKAGE object-storage buckets against the deletion outbox and the
 * orphan reconciliation scanner:
 *
 *   `agent-packages`   — `{packageId}/{version}.afps`
 *   `library-packages` — `{orgId|_system}/{folder}/{itemId}.afps`
 *
 * Both used to sit entirely outside the outbox: `deleteOrganization` dropped
 * the `packages` rows while their ZIPs stayed in storage forever. These tests
 * pin BOTH halves of the fix and, critically, the exact KEY STRINGS — a job
 * pointing at the wrong key deletes nothing while the row count still looks
 * green, so every assertion here compares against a key produced by the real
 * upload path rather than against a count.
 *
 * The cross-tenant hazard: `agent-packages` keys are NOT org-prefixed. They are
 * safe to purge per-org only because `packages.id` is the table's PRIMARY KEY
 * (one row per `@scope/name` platform-wide), so ownership is unambiguous. The
 * "does not touch another org / the system catalog" cases below are what
 * guards that reasoning.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations, packages, storageDeletionJobs } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import type { StorageObject } from "@appstrate/core/storage";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { deleteOrganization } from "../../../src/services/organizations.ts";
import { deletePackageVersion } from "../../../src/services/package-versions.ts";
import { deleteOrgItem } from "../../../src/services/package-items/crud.ts";
import {
  uploadPackageZip,
  buildMinimalZip,
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import {
  CONFIG_BY_TYPE,
  PACKAGE_ITEMS_BUCKET,
  SYSTEM_STORAGE_NAMESPACE,
  packageItemKey,
} from "../../../src/services/package-items/config.ts";
import {
  orphanScanBuckets,
  diffBucket,
  runWorkspaceOwner,
  type OrphanScanBucket,
} from "../../../src/services/storage-orphans.ts";

const app = getTestApp();

const MANIFEST = { name: "@x/y", version: "1.0.0", type: "agent" };

/** Every deletion job currently queued for `bucket`, keyed by storage key. */
async function jobsIn(bucket: string): Promise<Map<string, { reason: string }>> {
  const rows = await db
    .select()
    .from(storageDeletionJobs)
    .where(eq(storageDeletionJobs.bucket, bucket));
  return new Map(rows.map((r) => [r.storageKey, { reason: r.reason }]));
}

/** The descriptor for one bucket from the production scan table. */
function descriptorFor(bucket: string): OrphanScanBucket {
  const d = orphanScanBuckets().find((b) => b.bucket === bucket);
  if (!d) throw new Error(`no orphan-scan descriptor for bucket ${bucket}`);
  return d;
}

/** A synthetic bucket listing — stands in for `listObjects` so the diff is deterministic. */
function objects(...entries: [key: string, ageHours: number][]): StorageObject[] {
  return entries.map(([key, ageHours]) => ({
    key,
    size: 10,
    lastModified: new Date(Date.now() - ageHours * 60 * 60 * 1000),
  }));
}

/** Run the production diff for `bucket` against the CURRENT DB known-set. */
async function scan(bucket: string, listing: StorageObject[], minAgeHours = 24) {
  const descriptor = descriptorFor(bucket);
  return diffBucket(bucket, listing, await descriptor.loadKnown(), {
    cutoffMs: Date.now() - minAgeHours * 60 * 60 * 1000,
    identityOf: descriptor.identityOf,
  });
}

describe("package storage: deletion outbox + orphan reconciliation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pkgstore" });
    void app;
  });

  // ── deleteOrganization → outbox ─────────────────────────────

  it("enqueues exact agent-packages AND library-packages keys for the org's packages", async () => {
    const pkg = await seedPackage({ id: "@mine/report", type: "agent", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: pkg.id, version: "1.0.0" });
    await seedPackageVersion({ packageId: pkg.id, version: "1.1.0" });

    // Write the real objects through the production upload paths, then assert
    // the enqueued keys are the keys those writes actually produced.
    await uploadPackageZip(pkg.id, "1.0.0", buildMinimalZip(MANIFEST, "p"));
    await uploadPackageZip(pkg.id, "1.1.0", buildMinimalZip(MANIFEST, "p"));
    await uploadPackageFiles("agents", ctx.orgId, pkg.id, {
      "manifest.json": new TextEncoder().encode("{}"),
    });

    const itemKey = packageItemKey("agents", ctx.orgId, pkg.id);
    expect(await storage.downloadFile(PACKAGE_ITEMS_BUCKET, itemKey)).not.toBeNull();
    expect(
      await storage.downloadFile(AGENT_PACKAGES_BUCKET, versionZipKey(pkg.id, "1.0.0")),
    ).not.toBeNull();

    await deleteOrganization(ctx.orgId);

    expect(await db.select().from(organizations).where(eq(organizations.id, ctx.orgId))).toEqual(
      [],
    );

    const zipJobs = await jobsIn(AGENT_PACKAGES_BUCKET);
    expect([...zipJobs.keys()].sort()).toEqual([
      "@mine/report/1.0.0.afps",
      "@mine/report/1.1.0.afps",
    ]);
    expect(zipJobs.get(versionZipKey(pkg.id, "1.0.0"))!.reason).toBe("org_deleted");

    const itemJobs = await jobsIn(PACKAGE_ITEMS_BUCKET);
    expect([...itemJobs.keys()]).toEqual([itemKey]);
    expect(itemKey).toBe(`${ctx.orgId}/agents/@mine/report.afps`);
    expect(itemJobs.get(itemKey)!.reason).toBe("org_deleted");
  });

  it("uses the package row's type to pick the library folder (skill → skills/)", async () => {
    const skill = await seedPackage({ id: "@mine/helper", type: "skill", orgId: ctx.orgId });

    await deleteOrganization(ctx.orgId);

    const itemJobs = await jobsIn(PACKAGE_ITEMS_BUCKET);
    expect([...itemJobs.keys()]).toEqual([`${ctx.orgId}/skills/${skill.id}.afps`]);
  });

  it("never enqueues another org's or the system catalog's package objects", async () => {
    const other = await createTestContext({ orgSlug: "otherorg" });

    const mine = await seedPackage({ id: "@mine/a", type: "agent", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: mine.id, version: "1.0.0" });

    const theirs = await seedPackage({ id: "@theirs/b", type: "agent", orgId: other.orgId });
    await seedPackageVersion({ packageId: theirs.id, version: "2.0.0" });

    // System package: `orgId` null, artifacts under the global `_system/` namespace.
    const sys = await seedPackage({
      id: "@appstrate/system-agent",
      type: "agent",
      orgId: null,
      source: "system",
    });
    await seedPackageVersion({ packageId: sys.id, version: "3.0.0" });

    await deleteOrganization(ctx.orgId);

    const zipJobs = await jobsIn(AGENT_PACKAGES_BUCKET);
    expect([...zipJobs.keys()]).toEqual([versionZipKey(mine.id, "1.0.0")]);
    expect(zipJobs.has(versionZipKey(theirs.id, "2.0.0"))).toBe(false);
    expect(zipJobs.has(versionZipKey(sys.id, "3.0.0"))).toBe(false);

    const itemJobs = await jobsIn(PACKAGE_ITEMS_BUCKET);
    expect([...itemJobs.keys()]).toEqual([packageItemKey("agents", ctx.orgId, mine.id)]);
    expect(itemJobs.has(packageItemKey("agents", SYSTEM_STORAGE_NAMESPACE, sys.id))).toBe(false);

    // The other org's rows survive the cascade untouched.
    expect(await db.select().from(packages).where(eq(packages.id, theirs.id))).toHaveLength(1);
    expect(await db.select().from(packages).where(eq(packages.id, sys.id))).toHaveLength(1);
  });

  it("deletePackageVersion enqueues the artifact in the same transaction as the row delete", async () => {
    const pkg = await seedPackage({ id: "@mine/versioned", type: "agent", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: pkg.id, version: "1.0.0" });
    await seedPackageVersion({ packageId: pkg.id, version: "1.1.0" });

    expect(await deletePackageVersion(pkg.id, "1.0.0")).toBe(true);

    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(
        and(
          eq(storageDeletionJobs.bucket, AGENT_PACKAGES_BUCKET),
          eq(storageDeletionJobs.storageKey, versionZipKey(pkg.id, "1.0.0")),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.reason).toBe("version_deleted");
    expect(jobs[0]!.completedAt).toBeNull();

    // The surviving version's artifact is untouched.
    expect((await jobsIn(AGENT_PACKAGES_BUCKET)).has(versionZipKey(pkg.id, "1.1.0"))).toBe(false);
  });

  // ── deleteOrgItem → outbox ──────────────────────────────────

  it("deleteOrgItem enqueues the library object AND every published version ZIP", async () => {
    const other = await createTestContext({ orgSlug: "itemother" });

    const item = await seedPackage({ id: "@mine/doomed", type: "skill", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: item.id, version: "1.0.0" });
    await seedPackageVersion({ packageId: item.id, version: "2.0.0" });

    // Bystanders that must survive: another org's package, and a system one.
    const theirs = await seedPackage({ id: "@theirs/kept", type: "skill", orgId: other.orgId });
    await seedPackageVersion({ packageId: theirs.id, version: "1.0.0" });
    const sys = await seedPackage({
      id: "@appstrate/sys-kept",
      type: "skill",
      orgId: null,
      source: "system",
    });
    await seedPackageVersion({ packageId: sys.id, version: "1.0.0" });

    // Objects written through the production upload paths.
    await uploadPackageZip(item.id, "1.0.0", buildMinimalZip(MANIFEST, "p"));
    await uploadPackageFiles("skills", ctx.orgId, item.id, {
      "manifest.json": new TextEncoder().encode("{}"),
    });

    const result = await deleteOrgItem(ctx.orgId, item.id, CONFIG_BY_TYPE.skill);
    expect(result.ok).toBe(true);
    expect(await db.select().from(packages).where(eq(packages.id, item.id))).toHaveLength(0);

    // The part that leaked before this fix: BOTH published version ZIPs.
    const zipJobs = await jobsIn(AGENT_PACKAGES_BUCKET);
    expect([...zipJobs.keys()].sort()).toEqual([
      "@mine/doomed/1.0.0.afps",
      "@mine/doomed/2.0.0.afps",
    ]);
    expect(zipJobs.get(versionZipKey(item.id, "1.0.0"))!.reason).toBe("package_deleted");

    const itemKey = packageItemKey("skills", ctx.orgId, item.id);
    const itemJobs = await jobsIn(PACKAGE_ITEMS_BUCKET);
    expect([...itemJobs.keys()]).toEqual([itemKey]);
    expect(itemKey).toBe(`${ctx.orgId}/skills/@mine/doomed.afps`);
    expect(itemJobs.get(itemKey)!.reason).toBe("package_deleted");

    // Another org's and the system catalog's objects are untouched.
    expect(zipJobs.has(versionZipKey(theirs.id, "1.0.0"))).toBe(false);
    expect(zipJobs.has(versionZipKey(sys.id, "1.0.0"))).toBe(false);
    expect(itemJobs.has(packageItemKey("skills", other.orgId, theirs.id))).toBe(false);
    expect(itemJobs.has(packageItemKey("skills", SYSTEM_STORAGE_NAMESPACE, sys.id))).toBe(false);
    expect(await db.select().from(packages).where(eq(packages.id, theirs.id))).toHaveLength(1);
    expect(await db.select().from(packages).where(eq(packages.id, sys.id))).toHaveLength(1);
  });

  it("deleteOrgItem enqueues nothing when the delete matches no row (type mismatch)", async () => {
    const item = await seedPackage({ id: "@mine/askill", type: "skill", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: item.id, version: "1.0.0" });

    // Same id, wrong type config → the delete filter matches nothing. Queuing
    // the artifacts here would purge the bytes of a package that is still live.
    await deleteOrgItem(ctx.orgId, item.id, CONFIG_BY_TYPE.agent);

    expect(await db.select().from(packages).where(eq(packages.id, item.id))).toHaveLength(1);
    expect((await jobsIn(AGENT_PACKAGES_BUCKET)).size).toBe(0);
    expect((await jobsIn(PACKAGE_ITEMS_BUCKET)).size).toBe(0);
  });

  // ── orphan scanner ──────────────────────────────────────────

  it("reports a stranded agent-packages object and spares the live one", async () => {
    const pkg = await seedPackage({ id: "@mine/live", type: "agent", orgId: ctx.orgId });
    await seedPackageVersion({ packageId: pkg.id, version: "1.0.0" });

    const live = versionZipKey(pkg.id, "1.0.0");
    const stranded = "@mine/live/9.9.9.afps"; // version row deleted, bytes left behind

    const diff = await scan(AGENT_PACKAGES_BUCKET, objects([live, 100], [stranded, 100]));

    expect(diff.scanned).toBe(2);
    expect(diff.orphans.map((o) => o.key)).toEqual([stranded]);
  });

  it("reports a stranded library-packages object, spares the live one AND the _system namespace", async () => {
    const mine = await seedPackage({ id: "@mine/kept", type: "agent", orgId: ctx.orgId });
    const sys = await seedPackage({
      id: "@appstrate/sys-skill",
      type: "skill",
      orgId: null,
      source: "system",
    });

    const liveOrg = packageItemKey("agents", ctx.orgId, mine.id);
    const liveSystem = packageItemKey("skills", SYSTEM_STORAGE_NAMESPACE, sys.id);
    const stranded = packageItemKey("agents", ctx.orgId, "@mine/deleted");

    expect(liveSystem.startsWith("_system/")).toBe(true);

    const diff = await scan(
      PACKAGE_ITEMS_BUCKET,
      objects([liveOrg, 100], [liveSystem, 100], [stranded, 100]),
    );

    expect(diff.scanned).toBe(3);
    // The system object is in the known-set (built with NO org filter), so it
    // is never a candidate for deletion.
    expect(diff.orphans.map((o) => o.key)).toEqual([stranded]);
  });

  it("skips a row-less object still inside the grace window (upload commits after the write)", async () => {
    const stranded = "@mine/racing/1.0.0.afps";

    const fresh = await scan(AGENT_PACKAGES_BUCKET, objects([stranded, 1]), 24);
    expect(fresh.orphans).toEqual([]);
    expect(fresh.recentSkipped).toBe(1);

    const old = await scan(AGENT_PACKAGES_BUCKET, objects([stranded, 100]), 24);
    expect(old.orphans.map((o) => o.key)).toEqual([stranded]);
    expect(old.recentSkipped).toBe(0);
  });

  it("treats an object with no reported lastModified as old", async () => {
    const diff = await diffBucket(
      AGENT_PACKAGES_BUCKET,
      [{ key: "@mine/notime/1.0.0.afps" }],
      new Set<string>(),
      { cutoffMs: Date.now() },
    );
    expect(diff.orphans.map((o) => o.key)).toEqual(["@mine/notime/1.0.0.afps"]);
  });

  it("maps run-workspace objects back to their run and never orphans an unparseable key", async () => {
    expect(runWorkspaceOwner("run_abc.afps")).toBe("run_abc");
    expect(runWorkspaceOwner("run_abc/manifest.json")).toBe("run_abc");
    expect(runWorkspaceOwner("run_abc/documents/a.txt")).toBe("run_abc");
    expect(runWorkspaceOwner("stray-object")).toBeNull();

    const diff = await diffBucket(
      "run-workspace",
      objects(["run_live/documents/a.txt", 100], ["run_dead/manifest.json", 100], ["stray", 100]),
      new Set(["run_live"]),
      { cutoffMs: Date.now() - 24 * 60 * 60 * 1000, identityOf: runWorkspaceOwner },
    );

    expect(diff.orphans.map((o) => o.key)).toEqual(["run_dead/manifest.json"]);
    expect(diff.unrecognized).toEqual(["stray"]);
  });
});
