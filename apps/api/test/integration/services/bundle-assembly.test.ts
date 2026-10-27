// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: end-to-end Bundle assembly via DbPackageCatalog, through
 * the export-side assembly (`assembleAgentBundle`, no signature policy).
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

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { zipSync } from "fflate";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { assembleAgentBundle } from "../../../src/services/package-storage.ts";
import { buildBundleFromAgentDraft } from "../../../src/services/bundle-assembly.ts";
import type { AgentManifest } from "../../../src/types/index.ts";
import {
  BundleError,
  extractRootFromAfps,
  readBundleFromBuffer,
  writeBundleToBuffer,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { toBundleApiError } from "../../../src/services/run-launcher/bundle-error-mapping.ts";
import { DbPackageCatalog } from "../../../src/services/run-launcher/db-package-catalog.ts";
import { BundleSignatureError } from "../../../src/services/run-launcher/bundle-signature-policy.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

const BUCKET = "agent-packages";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildAfps(manifest: Record<string, unknown>, content: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
  };
  // AFPS §3.3/§3.4 companion files, satisfying both the loader rule (an inline
  // frontmatter `name`; a non-empty prompt.md for an agent) and the stricter
  // write-path rule (a bare-slug `name` plus a `description`).
  if (manifest.type === "skill") {
    const id = typeof manifest.name === "string" ? manifest.name : "@test/skill";
    const slug = id.split("/").pop()!;
    files["SKILL.md"] = enc(
      `---\nname: ${slug}\ndescription: Test skill ${slug}.\n---\n\n${content}`,
    );
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

/** The export's assembly for a root that declares no integration. */
function assembleForExport(root: BundlePackage, orgId: string) {
  return assembleAgentBundle(root, { orgId, integrationVersions: {}, forExecution: false });
}

describe("bundle-assembly — end-to-end via DbPackageCatalog", () => {
  let ctx: TestContext;
  let ORG_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundletest" });
    ORG_ID = ctx.org.id;
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

    const bundle = await assembleForExport(root, ORG_ID);

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

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundletest" });
    ORG_ID = ctx.org.id;
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
      await assembleForExport(root, ORG_ID);
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

    const bundle = await assembleForExport(root, ORG_ID);
    expect(bundle.packages.has("@test/skill-a@1.0.0" as PackageIdentity)).toBe(true);
  });
});

/**
 * The signature policy gates what RUNS. Export assembles the same dependency
 * graph through the same catalog, and must not be refused by it.
 */
describe("bundle-assembly — signature policy placement", () => {
  let ORG_ID: string;
  const skill = {
    name: "@test/skill-a",
    version: "1.0.0",
    type: "skill",
    schema_version: "0.1",
    display_name: "A",
    author: "tester",
  };
  const savedPolicy = process.env.AFPS_SIGNATURE_POLICY;

  beforeEach(async () => {
    await truncateAll();
    ORG_ID = (await createTestContext({ orgSlug: "bundletest" })).org.id;
    await seedPackageWithZip({
      id: "@test/skill-a",
      type: "skill",
      version: "1.0.0",
      orgId: ORG_ID,
      manifest: skill,
    });
    process.env.AFPS_SIGNATURE_POLICY = "required";
    resetEnvCache();
  });

  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.AFPS_SIGNATURE_POLICY;
    else process.env.AFPS_SIGNATURE_POLICY = savedPolicy;
    resetEnvCache();
  });

  it("refuses an unsigned package on the execution fetch only", async () => {
    const identity = "@test/skill-a@1.0.0" as PackageIdentity;
    expect((await new DbPackageCatalog({ orgId: ORG_ID }).fetch(identity)).identity).toBe(identity);
    await expect(
      new DbPackageCatalog({ orgId: ORG_ID, forExecution: true }).fetch(identity),
    ).rejects.toBeInstanceOf(BundleSignatureError);
  });
});

/**
 * The export freezes integration versions the way a run does, so a pin no
 * published version satisfies fails the export like it fails a run.
 */
describe("bundle-assembly — export integration freeze", () => {
  it("an unsatisfiable integration pin is DEPENDENCY_UNRESOLVED, mapped to 422", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "bundletest" });
    const integ = {
      name: "@test/integ",
      version: "1.0.0",
      type: "integration",
      schema_version: "0.2",
      display_name: "Integ",
      source: { kind: "none" },
    };
    await seedPackage({ id: "@test/integ", type: "integration", orgId: ctx.org.id });
    await seedPackageVersion({ packageId: "@test/integ", version: "1.0.0", manifest: integ });

    const manifest = {
      name: "@test/agent-root",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.2",
      display_name: "Root",
      dependencies: { integrations: { "@test/integ": "^3.0.0" } },
    };
    const caught = await buildBundleFromAgentDraft(
      {
        id: manifest.name,
        manifest: manifest as unknown as AgentManifest,
        prompt: "Do the thing.",
        source: "local",
      },
      { orgId: ctx.org.id, spaceId: ctx.defaultSpaceId },
    ).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).details).toEqual({
      missing: [{ name: "@test/integ", versionSpec: "^3.0.0" }],
    });
    const mapped = toBundleApiError(caught);
    expect(mapped?.status).toBe(422);
    expect(mapped?.code).toBe("dependency_unresolved");
  });
});

/**
 * An integration member is optional in a run bundle: an unsigned org
 * integration under `AFPS_SIGNATURE_POLICY=required` withholds its doc with a
 * warning, it does not fail the run.
 */
describe("bundle-assembly — unsigned integration under a required signature policy", () => {
  const INTEG = "@test/unsigned-integ";
  const savedPolicy = process.env.AFPS_SIGNATURE_POLICY;
  let ORG_ID: string;

  const root: BundlePackage = {
    identity: "@test/agent-root@1.0.0" as PackageIdentity,
    manifest: {
      name: "@test/agent-root",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.2",
      display_name: "Root",
      dependencies: { integrations: { [INTEG]: "^1.0.0" } },
      integrations_configuration: { [INTEG]: {} },
    },
    files: new Map([["prompt.md", enc("Do the thing.")]]),
    integrity: "",
  };

  beforeEach(async () => {
    await truncateAll();
    ORG_ID = (await createTestContext({ orgSlug: "bundletest" })).org.id;
    const manifest = {
      name: INTEG,
      version: "1.0.0",
      type: "integration",
      schema_version: "0.2",
      display_name: "Integ",
      source: { kind: "none" },
    };
    const afps = zipSync({
      "manifest.json": enc(JSON.stringify(manifest, null, 2)),
      "INTEGRATION.md": enc("# Integ\n"),
    });
    await seedPackage({ id: INTEG, type: "integration", orgId: ORG_ID });
    await storage.uploadFile(BUCKET, `${INTEG}/1.0.0.afps`, Buffer.from(afps));
    await seedPackageVersion({
      packageId: INTEG,
      version: "1.0.0",
      integrity: computeIntegrity(afps),
      artifactSize: afps.length,
      manifest,
    });
    process.env.AFPS_SIGNATURE_POLICY = "required";
    resetEnvCache();
  });

  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.AFPS_SIGNATURE_POLICY;
    else process.env.AFPS_SIGNATURE_POLICY = savedPolicy;
    resetEnvCache();
  });

  const integrationVersions = { [INTEG]: { version: "1.0.0", source: "version" as const } };

  it("builds the run bundle without the member and warns", async () => {
    const warnings: string[] = [];
    const bundle = await assembleAgentBundle(root, {
      orgId: ORG_ID,
      integrationVersions,
      forExecution: true,
      onWarn: (message) => warnings.push(message),
    });

    expect(bundle.packages.has(`${INTEG}@1.0.0` as PackageIdentity)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${INTEG}@1.0.0`);
    expect(warnings[0]).toContain("skipped");
  });

  it("keeps the member in the export, which applies no signature policy", async () => {
    const bundle = await assembleAgentBundle(root, {
      orgId: ORG_ID,
      integrationVersions,
      forExecution: false,
    });
    expect(bundle.packages.has(`${INTEG}@1.0.0` as PackageIdentity)).toBe(true);
  });
});
