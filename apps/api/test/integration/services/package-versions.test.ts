// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  createPackageVersion,
  listPackageVersions,
  getLatestVersionId,
  getVersionCount,
  getVersionInfo,
  getLatestVersionCreatedAt,
} from "../../../src/services/package-versions.ts";
describe("package-versions service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
  });

  // ── createPackageVersion ──────────────────────────────────

  describe("createPackageVersion", () => {
    it("creates a version for an existing package", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/my-agent` });

      const result = await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc123",
        artifactSize: 2048,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      expect(result).not.toBeNull();
      expect(result!.version).toBe("1.0.0");
      expect(typeof result!.id).toBe("number");
    });

    it("auto-assigns the latest dist-tag on first version", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/tagged-agent` });

      const result = await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      const latestId = await getLatestVersionId(pkg.id);
      expect(latestId).toBe(result!.id);
    });

    it("returns null for invalid semver", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/bad-ver` });

      const result = await createPackageVersion({
        packageId: pkg.id,
        version: "not-semver",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "not-semver", type: "agent" },
        createdBy: userId,
      });

      expect(result).toBeNull();
    });

    it("returns existing version if same version is created twice", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/dup-agent` });
      const params = {
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      };

      const first = await createPackageVersion(params);
      const second = await createPackageVersion(params);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.id).toBe(first!.id);
    });

    it("updates latest dist-tag when a higher version is published", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/bump-agent` });
      const base = {
        packageId: pkg.id,
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, type: "agent" } as Record<string, unknown>,
        createdBy: userId,
      };

      await createPackageVersion({
        ...base,
        version: "1.0.0",
        manifest: { ...base.manifest, version: "1.0.0" },
      });
      const v2 = await createPackageVersion({
        ...base,
        version: "2.0.0",
        manifest: { ...base.manifest, version: "2.0.0" },
      });

      const latestId = await getLatestVersionId(pkg.id);
      expect(latestId).toBe(v2!.id);
    });
  });

  // ── listPackageVersions ───────────────────────────────────

  describe("listPackageVersions", () => {
    it("returns all versions for a package, newest first", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/list-agent` });
      const base = {
        packageId: pkg.id,
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, type: "agent" } as Record<string, unknown>,
        createdBy: userId,
      };

      await createPackageVersion({
        ...base,
        version: "1.0.0",
        manifest: { ...base.manifest, version: "1.0.0" },
      });
      await createPackageVersion({
        ...base,
        version: "2.0.0",
        manifest: { ...base.manifest, version: "2.0.0" },
      });
      await createPackageVersion({
        ...base,
        version: "3.0.0",
        manifest: { ...base.manifest, version: "3.0.0" },
      });

      const versions = await listPackageVersions(pkg.id);

      expect(versions).toHaveLength(3);
      // Newest first
      expect(versions[0]!.version).toBe("3.0.0");
      expect(versions[2]!.version).toBe("1.0.0");
    });

    it("returns empty array for a package with no versions", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/empty-agent` });

      const versions = await listPackageVersions(pkg.id);
      expect(versions).toHaveLength(0);
    });

    it("includes yanked flag in results", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/yank-list` });

      await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      const before = await listPackageVersions(pkg.id);
      expect(before[0]!.yanked).toBe(false);

      // Directly mark as yanked via DB (yankVersion was removed — no route exposes it)
      await db
        .update(packageVersions)
        .set({ yanked: true })
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "1.0.0")));

      const after = await listPackageVersions(pkg.id);
      expect(after[0]!.yanked).toBe(true);
    });
  });

  // ── getLatestVersionId ────────────────────────────────────

  describe("getLatestVersionId", () => {
    it("returns null when no versions exist", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/no-ver` });
      const result = await getLatestVersionId(pkg.id);
      expect(result).toBeNull();
    });

    it("returns the version pointed to by the latest dist-tag", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/latest-agent` });

      const v1 = await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      const latestId = await getLatestVersionId(pkg.id);
      expect(latestId).toBe(v1!.id);
    });
  });

  // ── getVersionCount ───────────────────────────────────────

  describe("getVersionCount", () => {
    it("returns the correct count", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/count-agent` });
      expect(await getVersionCount(pkg.id)).toBe(0);

      await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      expect(await getVersionCount(pkg.id)).toBe(1);
    });
  });

  // ── getVersionInfo ────────────────────────────────────────

  describe("getVersionInfo", () => {
    it("returns activeVersion from manifest and null latestPublishedVersion when no versions exist", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/info-no-ver`,
        draftManifest: {
          name: `@${orgSlug}/info-no-ver`,
          version: "0.5.0",
          type: "agent",
        },
      });

      const info = await getVersionInfo(`@${orgSlug}/info-no-ver`, orgId);
      expect(info.activeVersion).toBe("0.5.0");
      expect(info.latestPublishedVersion).toBeNull();
    });

    it("returns latestPublishedVersion from the latest dist-tag", async () => {
      const pkg = await seedPackage({
        orgId,
        id: `@${orgSlug}/info-pub`,
        draftManifest: {
          name: `@${orgSlug}/info-pub`,
          version: "2.0.0",
          type: "agent",
        },
      });

      await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
      });

      const info = await getVersionInfo(pkg.id, orgId);
      expect(info.activeVersion).toBe("2.0.0");
      expect(info.latestPublishedVersion).toBe("1.0.0");
    });

    it("returns null activeVersion when manifest has no version", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/info-no-manifest-ver`,
        draftManifest: { name: `@${orgSlug}/info-no-manifest-ver`, type: "agent" },
      });

      const info = await getVersionInfo(`@${orgSlug}/info-no-manifest-ver`, orgId);
      expect(info.activeVersion).toBeNull();
      expect(info.latestPublishedVersion).toBeNull();
    });
  });

  // ── getLatestVersionCreatedAt ─────────────────────────────

  describe("getLatestVersionCreatedAt", () => {
    it("returns null when no versions exist", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/no-ver-date` });
      const result = await getLatestVersionCreatedAt(pkg.id);
      expect(result).toBeNull();
    });

    it("returns the most recent version createdAt", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/ver-date` });
      const base = {
        packageId: pkg.id,
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, type: "agent" } as Record<string, unknown>,
        createdBy: userId,
      };

      await createPackageVersion({
        ...base,
        version: "1.0.0",
        manifest: { ...base.manifest, version: "1.0.0" },
      });
      await createPackageVersion({
        ...base,
        version: "2.0.0",
        manifest: { ...base.manifest, version: "2.0.0" },
      });

      const result = await getLatestVersionCreatedAt(pkg.id);
      expect(result).toBeInstanceOf(Date);

      // The latest createdAt should be very recent (within 5s)
      const diff = Date.now() - result!.getTime();
      expect(diff).toBeLessThan(5000);
    });
  });
});
