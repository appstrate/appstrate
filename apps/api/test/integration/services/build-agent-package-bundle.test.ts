// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: `buildAgentPackage` emits the canonical multi-package
 * `.afps-bundle` format AND resolves skill dependencies against PUBLISHED
 * versions honoring each manifest pin (#666).
 *
 * The run hot path used to resolve skill deps against their mutable DRAFT
 * state, ignoring the pin — so a mid-edit skill leaked into every consumer
 * run. These tests pin the corrected contract:
 *   - default: a pinned skill resolves to its published version, NOT the
 *     dependency author's draft (the bug repro from the issue);
 *   - a new published version is picked up by the existing range on the
 *     next build (no agent republish);
 *   - an unsatisfiable pin (incl. never-published dep) fails loud with
 *     `DEPENDENCY_UNRESOLVED` instead of silently falling back to the draft;
 *   - the per-run `dependencyOverrides` escape hatch routes a single dep
 *     to its draft for the skill edit loop.
 *
 * NOTE: skills are the only bundle dependency the platform resolves.
 * Integrations / mcp-servers are spawned as separate MCP servers at runtime
 * (never embedded in the agent bundle).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db, truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { buildAgentPackage } from "../../../src/services/package-storage.ts";
import type { AgentManifest, LoadedPackage } from "../../../src/types/index.ts";
import { readBundleFromBuffer, BundleError } from "@appstrate/afps-runtime/bundle";
import { computeIntegrity } from "@appstrate/core/integrity";
import { packageDistTags, packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import * as storage from "@appstrate/db/storage";

const VERSIONS_BUCKET = "agent-packages";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array | undefined): string {
  return b ? new TextDecoder().decode(b) : "";
}

/** Build a minimal skill `.afps` (manifest.json + SKILL.md) for storage. */
function buildSkillAfps(id: string, version: string, body: string): Uint8Array {
  const manifest = {
    name: id,
    version,
    type: "skill",
    schema_version: "0.1",
    display_name: id,
    author: "tester",
  };
  return zipSync({
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "SKILL.md": enc(`---\nname: ${id}\n---\n\n${body}`),
  });
}

/**
 * Publish a skill version: package row + `package_versions` row + the AFPS in
 * the versions bucket (what `DbPackageCatalog`/`downloadVersionZip` reads) +
 * optionally the `latest` dist-tag.
 */
async function publishSkillVersion(opts: {
  id: `@${string}/${string}`;
  version: string;
  orgId: string;
  body: string;
  setLatest?: boolean;
}): Promise<void> {
  // Ensure the package row exists (idempotent across versions of the same id).
  await seedPackage({
    id: opts.id,
    type: "skill",
    orgId: opts.orgId,
    draftManifest: { name: opts.id, version: opts.version, type: "skill" },
  }).catch(() => undefined);

  const afps = buildSkillAfps(opts.id, opts.version, opts.body);
  const integrity = computeIntegrity(afps);
  await storage.uploadFile(VERSIONS_BUCKET, `${opts.id}/${opts.version}.afps`, Buffer.from(afps));
  const pv = await seedPackageVersion({
    packageId: opts.id,
    version: opts.version,
    integrity,
    artifactSize: afps.length,
    manifest: { name: opts.id, version: opts.version, type: "skill" },
  });
  if (opts.setLatest) {
    await db
      .insert(packageDistTags)
      .values({ packageId: opts.id, tag: "latest", versionId: pv.id })
      .onConflictDoUpdate({
        target: [packageDistTags.packageId, packageDistTags.tag],
        set: { versionId: pv.id, updatedAt: new Date() },
      });
  }
}

/** Drop a divergent DRAFT file set for a skill (the working-copy bytes). */
async function setSkillDraft(opts: {
  id: string;
  version: string;
  orgId: string;
  body: string;
}): Promise<void> {
  const manifest = { name: opts.id, version: opts.version, type: "skill" };
  await db.update(packages).set({ draftManifest: manifest }).where(eq(packages.id, opts.id));
  await uploadPackageFiles("skills", opts.orgId, opts.id, {
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "SKILL.md": enc(`---\nname: ${opts.id}\n---\n\n${opts.body}`),
  });
}

function buildAgent(manifest: Record<string, unknown>): LoadedPackage {
  return {
    id: manifest.name as string,
    manifest: manifest as unknown as AgentManifest,
    prompt: "You are the agent.",
    source: "local",
  };
}

/** Read the SKILL.md body of the single skill package in a built bundle. */
function skillBody(zip: Buffer): string {
  const bundle = readBundleFromBuffer(new Uint8Array(zip));
  for (const pkg of bundle.packages.values()) {
    const md = pkg.files.get("SKILL.md");
    if (md) return dec(md);
  }
  return "";
}

describe("buildAgentPackage — pin resolution against published versions (#666)", () => {
  let ctx: TestContext;
  let ORG_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundlehost" });
    ORG_ID = ctx.org.id;
  });

  it("resolves a pinned skill to its PUBLISHED version, not the divergent draft", async () => {
    const SKILL = "@bundlehost/test-skill" as const;
    // Published 1.0.0 says "version 1"; the draft working copy says "version 2".
    await publishSkillVersion({
      id: SKILL,
      version: "1.0.0",
      orgId: ORG_ID,
      body: "version 1",
      setLatest: true,
    });
    await setSkillDraft({ id: SKILL, version: "1.0.0", orgId: ORG_ID, body: "version 2" });

    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "3.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL]: "^1.0.0" } },
    };

    const result = await buildAgentPackage(buildAgent(agentManifest), ORG_ID);
    const bundle = readBundleFromBuffer(new Uint8Array(result.zip));

    expect(bundle.root).toBe("@bundlehost/root-agent@3.0.0");
    expect(bundle.packages.has(`${SKILL}@1.0.0`)).toBe(true);
    // The bug: pre-fix this delivered the draft ("version 2"). The pin must
    // win → published bytes.
    expect(skillBody(result.zip)).toContain("version 1");
    expect(skillBody(result.zip)).not.toContain("version 2");
  });

  it("picks up a newly published version that satisfies the existing range", async () => {
    const SKILL = "@bundlehost/test-skill" as const;
    await publishSkillVersion({ id: SKILL, version: "1.0.0", orgId: ORG_ID, body: "version 1" });
    await publishSkillVersion({
      id: SKILL,
      version: "1.1.0",
      orgId: ORG_ID,
      body: "version 1.1",
      setLatest: true,
    });

    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "1.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL]: "^1.0.0" } },
    };

    const result = await buildAgentPackage(buildAgent(agentManifest), ORG_ID);
    // `^1.0.0` re-resolves to the highest satisfying published version.
    expect(readBundleFromBuffer(new Uint8Array(result.zip)).packages.has(`${SKILL}@1.1.0`)).toBe(
      true,
    );
    expect(skillBody(result.zip)).toContain("version 1.1");
  });

  it("fails loud with DEPENDENCY_UNRESOLVED when the pin matches no published version", async () => {
    const SKILL = "@bundlehost/test-skill" as const;
    await publishSkillVersion({ id: SKILL, version: "1.0.0", orgId: ORG_ID, body: "v1" });

    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "1.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL]: "^9.0.0" } },
    };

    let caught: unknown;
    try {
      await buildAgentPackage(buildAgent(agentManifest), ORG_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).code).toBe("DEPENDENCY_UNRESOLVED");
  });

  it("fails loud for a never-published dependency (no silent draft fallback)", async () => {
    const SKILL = "@bundlehost/draft-only-skill" as const;
    // Draft bytes exist but NO published version — pre-fix this ran the draft.
    await seedPackage({
      id: SKILL,
      type: "skill",
      orgId: ORG_ID,
      draftManifest: { name: SKILL, version: "1.0.0", type: "skill" },
    });
    await setSkillDraft({ id: SKILL, version: "1.0.0", orgId: ORG_ID, body: "draft only" });

    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "1.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL]: "^1.0.0" } },
    };

    await expect(buildAgentPackage(buildAgent(agentManifest), ORG_ID)).rejects.toThrow(
      /unresolved/i,
    );
  });

  it("dependencyOverrides `draft` delivers the working-copy bytes for one dep", async () => {
    const SKILL = "@bundlehost/test-skill" as const;
    await publishSkillVersion({
      id: SKILL,
      version: "1.0.0",
      orgId: ORG_ID,
      body: "version 1",
      setLatest: true,
    });
    await setSkillDraft({ id: SKILL, version: "1.0.0", orgId: ORG_ID, body: "version 2 (draft)" });

    const agentManifest = {
      name: "@bundlehost/root-agent",
      version: "1.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL]: "^1.0.0" } },
    };

    // Without the override: published bytes.
    const published = await buildAgentPackage(buildAgent(agentManifest), ORG_ID);
    expect(skillBody(published.zip)).toContain("version 1");

    // With the override: the dependency's mutable draft.
    const drafted = await buildAgentPackage(buildAgent(agentManifest), ORG_ID, {
      [SKILL]: "draft",
    });
    expect(skillBody(drafted.zip)).toContain("version 2 (draft)");
  });
});

describe("buildAgentPackage — bundle output invariants", () => {
  let ctx: TestContext;
  let ORG_ID: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundlehost" });
    ORG_ID = ctx.org.id;
  });

  it("always emits a non-empty root package — the invariant behind the runtime's 404=fatal workspace fetch", async () => {
    // The agent runtime treats a 404 on GET /api/runs/:runId/workspace as a
    // FATAL provisioning fault, never a legitimately-empty workspace
    // (runtime-pi/entrypoint.ts `provisionWorkspace`). That 404=fatal
    // contract is sound ONLY because this chain never produces an empty
    // upload. This test pins the load-bearing end of that contract: even the
    // barest agent (no skills, no deps) yields a non-empty root package.
    const manifest = {
      name: "@bundlehost/bare-agent",
      version: "0.0.1",
      type: "agent",
      description: "No skills, no deps",
    };
    await seedPackage({
      id: "@bundlehost/bare-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: manifest,
    });

    const result = await buildAgentPackage(buildAgent(manifest), ORG_ID);

    expect(result.zip.byteLength).toBeGreaterThan(0);
    const bundle = readBundleFromBuffer(new Uint8Array(result.zip));
    expect(bundle.packages.size).toBeGreaterThanOrEqual(1);
    const rootPkg = bundle.packages.get(bundle.root)!;
    expect(rootPkg.files.has("manifest.json")).toBe(true);
    expect(rootPkg.files.has("prompt.md")).toBe(true);
  });

  it("produces a deterministic bundle — two builds yield byte-identical ZIPs", async () => {
    const manifest = {
      name: "@bundlehost/solo-agent",
      version: "1.2.3",
      type: "agent",
      description: "Standalone agent",
    };
    await seedPackage({
      id: "@bundlehost/solo-agent",
      type: "agent",
      orgId: ORG_ID,
      draftManifest: manifest,
    });

    const a = await buildAgentPackage(buildAgent(manifest), ORG_ID);
    const b = await buildAgentPackage(buildAgent(manifest), ORG_ID);
    expect(a.zip.equals(b.zip)).toBe(true);
  });
});
