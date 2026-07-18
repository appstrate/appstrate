// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions, packageVersionDependencies } from "@appstrate/db/schema";
import type { DepEntry } from "@appstrate/core/dependencies";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  createPackageVersion,
  createVersionAndUpload,
  createVersionFromDraft,
  listPackageVersions,
  getLatestVersionId,
  getLatestVersionInfo,
  getVersionCount,
  getVersionInfo,
  getLatestVersionCreatedAt,
} from "../../../src/services/package-versions.ts";
import { buildMinimalZip, downloadVersionZip } from "../../../src/services/package-storage.ts";
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

    it("rolls back the version row when the dependency-index write fails (atomic)", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/atomic-agent` });
      // Invalid `depType` (not in the package_type enum) makes the dependency
      // insert throw — inside the same transaction as the version row. Atomic =
      // the version row must NOT survive the rollback.
      const badDeps: DepEntry[] = [
        {
          depScope: "@acme",
          depName: "x",
          depType: "not-a-type" as DepEntry["depType"],
          versionRange: "^1.0.0",
        },
      ];

      await expect(
        createPackageVersion({
          packageId: pkg.id,
          version: "1.0.0",
          integrity: "sha256-abc",
          artifactSize: 1024,
          manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
          createdBy: userId,
          deps: badDeps,
        }),
      ).rejects.toThrow();

      expect(await getVersionCount(pkg.id)).toBe(0);
    });

    it("does not duplicate dependency-index rows when the same version is created twice", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/dup-deps-agent` });
      const params = {
        packageId: pkg.id,
        version: "1.0.0",
        integrity: "sha256-abc",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0", type: "agent" },
        createdBy: userId,
        deps: [
          {
            depScope: "@acme",
            depName: "fathom",
            depType: "integration" as DepEntry["depType"],
            versionRange: "^1.0.0",
          },
        ],
      };

      const first = await createPackageVersion(params);
      // Second create hits the "exists" branch → returns the existing row and
      // must NOT re-insert the dependency index.
      const second = await createPackageVersion(params);
      expect(second!.id).toBe(first!.id);

      const rows = await db
        .select({ id: packageVersionDependencies.id })
        .from(packageVersionDependencies)
        .where(eq(packageVersionDependencies.versionId, first!.id));
      expect(rows.length).toBe(1);
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

    it("does not infer latest from a prerelease-only package without a dist-tag", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/beta-only-agent` });

      const prerelease = await createPackageVersion({
        packageId: pkg.id,
        version: "1.0.0-beta.1",
        integrity: "sha256-beta",
        artifactSize: 1024,
        manifest: { name: pkg.id, version: "1.0.0-beta.1", type: "agent" },
        createdBy: userId,
      });

      expect(prerelease).not.toBeNull();
      expect(await getLatestVersionId(pkg.id)).toBeNull();
      expect(await getLatestVersionInfo(pkg.id)).toBeNull();
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
      expect(info.active_version).toBe("0.5.0");
      expect(info.latest_published_version).toBeNull();
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
      expect(info.active_version).toBe("2.0.0");
      expect(info.latest_published_version).toBe("1.0.0");
    });

    it("returns null activeVersion when manifest has no version", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/info-no-manifest-ver`,
        draftManifest: { name: `@${orgSlug}/info-no-manifest-ver`, type: "agent" },
      });

      const info = await getVersionInfo(`@${orgSlug}/info-no-manifest-ver`, orgId);
      expect(info.active_version).toBeNull();
      expect(info.latest_published_version).toBeNull();
    });
  });

  // ── createVersionFromDraft ────────────────────────────────

  describe("createVersionFromDraft", () => {
    // Regression: a prompt-only agent (no skills) declaring integrations used
    // to lose its entire `dependencies` block at publish (buildDependencies
    // returned null → the whole block was deleted), so the runtime saw
    // tool_not_found. Publish must preserve the authored dependencies verbatim.
    it("preserves authored dependencies.integrations verbatim for a skill-less agent", async () => {
      const id = `@${orgSlug}/prompt-only`;
      const draftManifest = {
        name: id,
        version: "1.0.0",
        type: "agent",
        dependencies: {
          integrations: {
            "@acme/fathom": "^1.2.4",
            "@appstrate/github": "^1.0.0",
          },
        },
        integrations_configuration: {
          "@acme/fathom": { tools: ["api_call"], auth_key: "primary" },
          "@appstrate/github": { tools: ["api_call"], auth_key: "primary" },
        },
      };
      const pkg = await seedPackage({ orgId, id, draftManifest, draftContent: "Prompt." });

      const result = await createVersionFromDraft({ packageId: pkg.id, orgId, userId });
      expect("error" in result).toBe(false);

      const [stored] = await db
        .select({ manifest: packageVersions.manifest })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "1.0.0")))
        .limit(1);

      const deps = (
        stored!.manifest as { dependencies?: { integrations?: Record<string, string> } }
      ).dependencies?.integrations;
      expect(deps).toEqual({
        "@acme/fathom": "^1.2.4",
        "@appstrate/github": "^1.0.0",
      });
    });

    // Atomicity: the derived dependency index is written in the same
    // transaction as the version row (no committed version with a missing index).
    it("populates the dependency index in the same step as the version row", async () => {
      const id = `@${orgSlug}/indexed`;
      const pkg = await seedPackage({
        orgId,
        id,
        draftManifest: {
          name: id,
          version: "1.0.0",
          type: "agent",
          dependencies: { integrations: { "@acme/fathom": "^1.2.4" } },
          integrations_configuration: { "@acme/fathom": { tools: ["api_call"] } },
        },
        draftContent: "Prompt.",
      });

      const result = await createVersionFromDraft({ packageId: pkg.id, orgId, userId });
      expect("error" in result).toBe(false);
      const versionId = (result as { id: number }).id;

      const rows = await db
        .select({ depName: packageVersionDependencies.depName })
        .from(packageVersionDependencies)
        .where(eq(packageVersionDependencies.versionId, versionId));
      expect(rows.map((r) => r.depName)).toContain("fathom");
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

  // ── AFPS §4.3 — circular dependency detection at publish ─────
  describe("createVersionAndUpload — cycle detection", () => {
    it("rejects a self-dependency at publish (fast-path)", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/self-dep` });
      const manifest: Record<string, unknown> = {
        name: pkg.id,
        version: "1.0.0",
        type: "agent",
        // Self-reference — same package id appears in its own deps.
        dependencies: { skills: { [pkg.id]: "^1.0.0" } },
      };
      const zip = Buffer.from(buildMinimalZip(manifest, "prompt"));

      await expect(
        createVersionAndUpload({
          packageId: pkg.id,
          version: "1.0.0",
          createdBy: userId,
          zipBuffer: zip,
          manifest,
        }),
      ).rejects.toThrow(/Circular dependency/);

      // No version row created.
      expect(await getVersionCount(pkg.id)).toBe(0);
    });
  });

  // ── #896 — published-artifact immutability at the publish gate ─────
  //
  // The old sequence uploaded the ZIP BEFORE deciding the version outcome, so
  // a republish of an existing version overwrote the stored bytes while the
  // row kept the integrity hash of the original publish — every subsequent
  // run then failed `bundle_integrity_mismatch`, and republishing (201) never
  // converged. These tests pin the invariant: whatever the publish outcome,
  // the stored bytes for an existing version keep matching its recorded hash.
  describe("createVersionAndUpload — published-artifact immutability (#896)", () => {
    it("republishing an existing version with different bytes returns 'exists' and leaves the artifact untouched", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/immutable` });
      const manifest: Record<string, unknown> = { name: pkg.id, version: "1.0.0", type: "agent" };
      const zipV1 = Buffer.from(buildMinimalZip(manifest, "original prompt"));

      const first = await createVersionAndUpload({
        packageId: pkg.id,
        version: "1.0.0",
        createdBy: userId,
        zipBuffer: zipV1,
        manifest,
      });
      expect(first!.outcome).toBe("created");

      const zipChanged = Buffer.from(buildMinimalZip(manifest, "CHANGED prompt"));
      const second = await createVersionAndUpload({
        packageId: pkg.id,
        version: "1.0.0",
        createdBy: userId,
        zipBuffer: zipChanged,
        manifest,
      });
      expect(second!.outcome).toBe("exists");
      expect(second!.id).toBe(first!.id);

      // Stored bytes must still hash to the integrity recorded at first
      // publish — downloadVersionZip re-verifies and throws on mismatch.
      const [row] = await db
        .select({ integrity: packageVersions.integrity })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "1.0.0")))
        .limit(1);
      const stored = await downloadVersionZip(pkg.id, "1.0.0", row!.integrity);
      expect(stored).not.toBeNull();
      expect(Buffer.compare(stored!, zipV1)).toBe(0);
    });

    it("a forward-only-rejected publish never touches storage", async () => {
      const pkg = await seedPackage({ orgId, id: `@${orgSlug}/forward-only` });
      const m2: Record<string, unknown> = { name: pkg.id, version: "2.0.0", type: "agent" };
      const created = await createVersionAndUpload({
        packageId: pkg.id,
        version: "2.0.0",
        createdBy: userId,
        zipBuffer: Buffer.from(buildMinimalZip(m2, "v2")),
        manifest: m2,
      });
      expect(created!.outcome).toBe("created");

      const m1: Record<string, unknown> = { name: pkg.id, version: "1.0.0", type: "agent" };
      const rejected = await createVersionAndUpload({
        packageId: pkg.id,
        version: "1.0.0",
        createdBy: userId,
        zipBuffer: Buffer.from(buildMinimalZip(m1, "v1")),
        manifest: m1,
      });
      expect(rejected).toBeNull();

      // No orphan artifact for the rejected version, and 2.0.0 still verifies.
      expect(await downloadVersionZip(pkg.id, "1.0.0")).toBeNull();
      const [row] = await db
        .select({ integrity: packageVersions.integrity })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "2.0.0")))
        .limit(1);
      expect(await downloadVersionZip(pkg.id, "2.0.0", row!.integrity)).not.toBeNull();
    });

    it("createVersionFromDraft answers version_exists when content changed without a version bump", async () => {
      const id = `@${orgSlug}/needs-bump`;
      const pkg = await seedPackage({
        orgId,
        id,
        draftManifest: { name: id, version: "1.0.0", type: "agent" },
        draftContent: "v1 prompt",
      });

      const first = await createVersionFromDraft({ packageId: pkg.id, orgId, userId });
      expect("error" in first).toBe(false);

      // Unchanged draft → still the dedup answer.
      const unchanged = await createVersionFromDraft({ packageId: pkg.id, orgId, userId });
      expect(unchanged).toEqual({ error: "no_changes" });

      // Changed content, same version → refuse loudly instead of the old
      // silent 201 that corrupted the stored artifact.
      await db
        .update(packages)
        .set({ draftContent: "v2 prompt — changed" })
        .where(eq(packages.id, pkg.id));
      const republished = await createVersionFromDraft({ packageId: pkg.id, orgId, userId });
      expect(republished).toEqual({ error: "version_exists" });

      // Published artifact still matches its recorded integrity.
      const [row] = await db
        .select({ integrity: packageVersions.integrity })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, "1.0.0")))
        .limit(1);
      expect(await downloadVersionZip(pkg.id, "1.0.0", row!.integrity)).not.toBeNull();
    });
  });
});
