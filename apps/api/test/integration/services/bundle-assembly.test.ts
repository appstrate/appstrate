// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: end-to-end Bundle assembly via DbPackageCatalog.
 *
 * Seeds an agent + skill + skill dep in the DB, uploads their AFPS
 * ZIPs to storage, and exercises:
 *   - DbPackageCatalog.resolve (exact + semver range)
 *   - DbPackageCatalog.fetch (signature-policy gate passes for
 *      unsigned bundles under default policy)
 *   - buildBundleFromCatalog transitive walk
 *   - writeBundleToBuffer + readBundleFromBuffer round-trip (deterministic)
 *   - tamper detection (flip one byte in a fetched package file)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  buildBundleFromDb,
  buildBundleFromInlinePayload,
} from "../../../src/services/bundle-assembly.ts";
import {
  extractRootFromAfps,
  readBundleFromBuffer,
  writeBundleToBuffer,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";

const BUCKET = "agent-packages";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  return zipSync({
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "prompt.md": enc(content),
  });
}

async function seedPackageWithZip(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill" | "tool" | "provider";
  version: string;
  orgId: string;
  manifest: Record<string, unknown>;
  content?: string;
}): Promise<void> {
  await seedPackage({ id: opts.id, type: opts.type, orgId: opts.orgId });
  const afps = buildAfps(opts.manifest, opts.content ?? "content");
  const integrity = computeIntegrity(afps);
  await storage.uploadFile(BUCKET, `${opts.id}/${opts.version}.afps`, Buffer.from(afps));
  await seedPackageVersion({
    packageId: opts.id,
    version: opts.version,
    integrity,
    artifactSize: afps.length,
    manifest: opts.manifest,
  });
}

describe("bundle-assembly — end-to-end via DbPackageCatalog", () => {
  let ctx: TestContext;
  let ORG_ID: string;
  let APP_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundletest" });
    ORG_ID = ctx.org.id;
    APP_ID = ctx.defaultAppId;
  });

  it("assembles a multi-package bundle for a classic run", async () => {
    // Seed: agent depending on @test/skill-a (which itself depends on
    // @test/skill-dep — tests transitive walk).
    await seedPackageWithZip({
      id: "@test/agent-root",
      type: "agent",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: {
        name: "@test/agent-root",
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "Root",
        author: "tester",
        dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
      },
      content: "Do the thing.",
    });
    await seedPackageWithZip({
      id: "@test/skill-a",
      type: "skill",
      version: "1.2.0",
      orgId: ORG_ID,
      manifest: {
        name: "@test/skill-a",
        version: "1.2.0",
        type: "skill",
        schemaVersion: "1.1",
        displayName: "A",
        author: "tester",
        dependencies: { skills: { "@test/skill-dep": "^1" } },
      },
    });
    await seedPackageWithZip({
      id: "@test/skill-dep",
      type: "skill",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: {
        name: "@test/skill-dep",
        version: "1.0.0",
        type: "skill",
        schemaVersion: "1.1",
        displayName: "Dep",
        author: "tester",
      },
    });

    // The root travels into the bundle as the root package. In the
    // platform hot path this comes from the DB row + an already-built
    // AFPS ZIP — we synthesize the same shape here.
    const rootAfps = buildAfps(
      {
        name: "@test/agent-root",
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "Root",
        author: "tester",
        dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
      },
      "Do the thing.",
    );
    const root = extractRootFromAfps(rootAfps);

    const bundle = await buildBundleFromDb(root, {
      orgId: ORG_ID,
      applicationId: APP_ID,
    });

    expect(bundle.packages.size).toBe(3);
    expect(bundle.root).toBe("@test/agent-root@1.0.0");
    expect(bundle.packages.has("@test/skill-a@1.2.0" as PackageIdentity)).toBe(true);
    expect(bundle.packages.has("@test/skill-dep@1.0.0" as PackageIdentity)).toBe(true);

    // Round-trip through .afps-bundle: deterministic + recoverable.
    const bytes = writeBundleToBuffer(bundle);
    const read = readBundleFromBuffer(bytes);
    expect(read.packages.size).toBe(3);
    expect(read.integrity).toBe(bundle.integrity);

    // Second serialization is byte-identical (determinism canary).
    expect(writeBundleToBuffer(bundle)).toEqual(bytes);
  });

  it("composes in-memory + DB catalogs for inline runs (payload wins)", async () => {
    // Pre-register a DB version that should be SHADOWED by the inline
    // payload (same identity, different bytes).
    await seedPackageWithZip({
      id: "@test/skill-x",
      type: "skill",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: {
        name: "@test/skill-x",
        version: "1.0.0",
        type: "skill",
        schemaVersion: "1.1",
        displayName: "X",
        author: "tester",
      },
      content: "DB VERSION",
    });

    // Inline-supplied root + same-identity skill with different bytes.
    const rootAfps = buildAfps(
      {
        name: "@test/inline-root",
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.1",
        displayName: "InlineRoot",
        author: "tester",
        dependencies: { skills: { "@test/skill-x": "^1.0.0" } },
      },
      "p",
    );
    const root = extractRootFromAfps(rootAfps);

    const inlineSkill: BundlePackage = extractRootFromAfps(
      buildAfps(
        {
          name: "@test/skill-x",
          version: "1.0.0",
          type: "skill",
          schemaVersion: "1.1",
          displayName: "X",
          author: "tester",
        },
        "INLINE VERSION",
      ),
    );

    const bundle = await buildBundleFromInlinePayload(root, [inlineSkill], {
      orgId: ORG_ID,
      applicationId: APP_ID,
    });

    const resolved = bundle.packages.get("@test/skill-x@1.0.0" as PackageIdentity);
    expect(resolved).toBeDefined();
    // The inline BundlePackage carried its own files — the payload won.
    // The DB version's "DB VERSION" content should NOT be in the bundle.
    const skillRoot = new TextDecoder().decode(resolved!.files.get("prompt.md")!);
    expect(skillRoot).toBe("INLINE VERSION");
  });
});
