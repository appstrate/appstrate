// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPackageVersion,
  createVersionFromDraft,
  listPackageVersions,
  getLatestVersionId,
  getVersionCount,
  getVersionInfo,
  getLatestVersionCreatedAt,
} from "../../../src/services/package-versions.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { downloadVersionZip } from "../../../src/services/package-storage.ts";
import { parsePackageZip } from "@appstrate/core/zip";
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

  // ── createVersionFromDraft — tool bundling ────────────────

  describe("createVersionFromDraft (tool)", () => {
    it("bundles the tool source and rewrites manifest.entrypoint to the emitted artifact", async () => {
      const toolId = `@${orgSlug}/my-tool`;
      // Source imports a sibling helper — proves the bundler inlines
      // relative imports, not just runs on single-file tools.
      const toolSource = [
        `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";`,
        `import { suffix } from "./helper.ts";`,
        `export default function (pi: ExtensionAPI) {`,
        `  (pi as unknown as { _value: string })._value = "ok" + suffix;`,
        `  return "ok" + suffix;`,
        `}`,
      ].join("\n");
      const helperSource = `export const suffix = "-ok";`;

      await seedPackage({
        orgId,
        id: toolId,
        type: "tool",
        draftManifest: {
          name: toolId,
          version: "1.0.0",
          type: "tool",
          entrypoint: "tool.ts",
          tool: { name: "my_tool", description: "t", inputSchema: {} },
        },
      });

      await uploadPackageFiles("tools", orgId, toolId, {
        "manifest.json": new TextEncoder().encode(
          JSON.stringify({
            name: toolId,
            version: "1.0.0",
            type: "tool",
            entrypoint: "tool.ts",
            tool: { name: "my_tool", description: "t", inputSchema: {} },
          }),
        ),
        "tool.ts": new TextEncoder().encode(toolSource),
        "helper.ts": new TextEncoder().encode(helperSource),
      });

      const result = await createVersionFromDraft({
        packageId: toolId,
        orgId,
        userId,
        version: "1.0.0",
      });
      if ("error" in result) throw new Error(`createVersionFromDraft: ${result.error}`);

      const zip = await downloadVersionZip(toolId, "1.0.0");
      expect(zip).not.toBeNull();

      const parsed = parsePackageZip(new Uint8Array(zip!));
      expect(parsed.type).toBe("tool");
      // Published archive: entrypoint rewritten to the bundled artifact.
      expect((parsed.manifest as Record<string, unknown>).entrypoint).toBe("tool.js");

      const bundled = parsed.files["tool.js"];
      expect(bundled).toBeDefined();
      const bundledText = new TextDecoder().decode(bundled!);
      // Relative import inlined — no sibling file reference remains.
      expect(bundledText).not.toContain(`from "./helper`);
      expect(bundledText).not.toContain(`from './helper`);
      // Source kept in the archive for reviewability/attribution.
      expect(parsed.files["tool.ts"]).toBeDefined();

      // E2E: the bundled artifact must be dynamic-importable and
      // actually register an extension factory. We write it to a
      // scratch path and invoke `import()` — same code path as
      // `prepareBundleForPi`.
      const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-tool-"));
      try {
        const bundledPath = path.join(scratchDir, "tool.js");
        await fs.writeFile(bundledPath, bundled!);
        const mod = (await import(bundledPath)) as { default?: unknown };
        expect(typeof mod.default).toBe("function");
        const fakePi = {} as Record<string, unknown>;
        const returned = (mod.default as (pi: unknown) => unknown)(fakePi);
        expect(returned).toBe("ok-ok");
        expect(fakePi._value).toBe("ok-ok");
      } finally {
        await fs.rm(scratchDir, { recursive: true, force: true });
      }
    });

    it("rejects tools whose manifest is missing entrypoint", async () => {
      const toolId = `@${orgSlug}/no-entry`;
      await seedPackage({
        orgId,
        id: toolId,
        type: "tool",
        draftManifest: {
          name: toolId,
          version: "1.0.0",
          type: "tool",
          tool: { name: "x", description: "t", inputSchema: {} },
          // Deliberately missing `entrypoint`
        },
      });
      await uploadPackageFiles("tools", orgId, toolId, {
        "manifest.json": new TextEncoder().encode("{}"),
      });

      let threw = false;
      try {
        await createVersionFromDraft({
          packageId: toolId,
          orgId,
          userId,
          version: "1.0.0",
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/entrypoint/);
      }
      expect(threw).toBe(true);
    });
  });
});
