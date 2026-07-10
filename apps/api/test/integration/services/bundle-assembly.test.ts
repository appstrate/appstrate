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
import { buildBundleFromDb } from "../../../src/services/bundle-assembly.ts";
import {
  BundleError,
  extractRootFromAfps,
  readBundleFromBuffer,
  writeBundleToBuffer,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { toBundleApiError } from "../../../src/services/run-launcher/bundle-error-mapping.ts";

const BUCKET = "agent-packages";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
  };
  // AFPS §3.3/§3.4 companion-file invariants enforced by the bundle loader:
  // agents need a non-empty prompt.md, skills need a SKILL.md with a
  // frontmatter `name`. Emit the right companion for the package type.
  if (manifest.type === "skill") {
    const name = typeof manifest.name === "string" ? manifest.name : "@test/skill";
    files["SKILL.md"] = enc(`---\nname: ${name}\n---\n\n${content}`);
  } else {
    files["prompt.md"] = enc(content);
  }
  return zipSync(files);
}

async function seedPackageWithZip(opts: {
  id: `@${string}/${string}`;
  type: "agent" | "skill";
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
        schema_version: "0.1",
        display_name: "Root",
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
        schema_version: "0.1",
        display_name: "A",
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
        schema_version: "0.1",
        display_name: "Dep",
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
        schema_version: "0.1",
        display_name: "Root",
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
});

/**
 * #878 issue 2 — the SRI gate at the storage boundary, exercised for real.
 *
 * `bundle-error-mapping.test.ts` proves every `BundleErrorCode` maps onto the
 * RFC 9457 contract, but only against hand-built `BundleError` instances. This
 * test proves the production side: bytes at rest that no longer hash to the
 * `package_versions.integrity` recorded at publish actually surface from
 * `downloadVersionZip` as a typed `BundleError("INTEGRITY_MISMATCH")` through
 * the same catalog fetch the run pipeline uses — and land on
 * `500 bundle_integrity_mismatch`, not an opaque `internal_error`.
 */
describe("bundle-assembly — storage integrity gate (#878)", () => {
  let ctx: TestContext;
  let ORG_ID: string;
  let APP_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundletest" });
    ORG_ID = ctx.org.id;
    APP_ID = ctx.defaultAppId;
  });

  it("tampered bytes at rest throw BundleError(INTEGRITY_MISMATCH), mapped to 500 bundle_integrity_mismatch", async () => {
    const skillManifest = {
      name: "@test/skill-a",
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "A",
      author: "tester",
    };
    await seedPackageWithZip({
      id: "@test/skill-a",
      type: "skill",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: skillManifest,
    });

    // Tamper at rest: overwrite the stored object AFTER its integrity was
    // recorded. Still a perfectly valid AFPS ZIP — only the SRI can catch it.
    const tampered = buildAfps(skillManifest, "tampered content");
    await storage.uploadFile(BUCKET, "@test/skill-a/1.0.0.afps", Buffer.from(tampered));

    const rootAfps = buildAfps(
      {
        name: "@test/agent-root",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Root",
        author: "tester",
        dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
      },
      "Do the thing.",
    );
    const root = extractRootFromAfps(rootAfps);

    let caught: unknown;
    try {
      await buildBundleFromDb(root, { orgId: ORG_ID, applicationId: APP_ID });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).code).toBe("INTEGRITY_MISMATCH");

    const mapped = toBundleApiError(caught);
    expect(mapped).not.toBeNull();
    expect(mapped!.status).toBe(500);
    expect(mapped!.code).toBe("bundle_integrity_mismatch");
  });

  it("untampered bytes pass the same gate — the guard has no false positives", async () => {
    const skillManifest = {
      name: "@test/skill-a",
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "A",
      author: "tester",
    };
    await seedPackageWithZip({
      id: "@test/skill-a",
      type: "skill",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: skillManifest,
    });

    const rootAfps = buildAfps(
      {
        name: "@test/agent-root",
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Root",
        author: "tester",
        dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
      },
      "Do the thing.",
    );
    const root = extractRootFromAfps(rootAfps);

    const bundle = await buildBundleFromDb(root, { orgId: ORG_ID, applicationId: APP_ID });
    expect(bundle.packages.has("@test/skill-a@1.0.0" as PackageIdentity)).toBe(true);
  });
});
