// SPDX-License-Identifier: Apache-2.0

/**
 * Agreement lock (#2005): the run bundle carries each integration at EXACTLY
 * the version the run froze, with that version's `INTEGRATION.md` bytes.
 *
 * Every case runs the pipeline's freeze (`freezeRunSpawnDependencies`), then
 * `buildAgentPackage` with the frozen map, and checks the integration member:
 * its identity version is the frozen one and its `INTEGRATION.md` is that
 * version's (or, for a draft override, the draft column). The spawn path and
 * the bundle therefore can never disagree on which integration a run used.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import { readBundleFromBuffer, type Bundle } from "@appstrate/afps-runtime/bundle";
import { buildAgentPackage } from "../../../src/services/package-storage.ts";
import { freezeRunSpawnDependencies } from "../../../src/services/run-pipeline.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { _setSystemPackagesForTesting } from "../../../src/services/system-packages.ts";
import type { AgentManifest, LoadedPackage } from "../../../src/types/index.ts";

const BUCKET = "agent-packages";
const INTEG = "@bundlever/integ";
const SYS_INTEG = "@sysver/integ";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

function integManifest(id: string, version: string): Record<string, unknown> {
  return {
    name: id,
    version,
    type: "integration",
    schema_version: "0.2",
    display_name: "Integ",
    source: { kind: "none" },
  };
}

const docFor = (version: string) => `# Integ\n\nDocumentation of ${version}.\n`;

/** Publish `version` of `id` with its own INTEGRATION.md (row + version row + stored AFPS). */
async function publishIntegration(id: string, version: string): Promise<void> {
  const manifest = integManifest(id, version);
  const afps = zipSync({
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "INTEGRATION.md": enc(docFor(version)),
  });
  await storage.uploadFile(BUCKET, `${id}/${version}.afps`, Buffer.from(afps));
  await seedPackageVersion({
    packageId: id,
    version,
    integrity: computeIntegrity(afps),
    artifactSize: afps.length,
    manifest,
  });
}

function agent(pin: string, integrationId = INTEG): LoadedPackage {
  const manifest = {
    schema_version: "0.2",
    type: "agent",
    name: "@bundlever/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [integrationId]: pin } },
    integrations_configuration: { [integrationId]: {} },
  };
  return {
    id: manifest.name,
    manifest: manifest as unknown as AgentManifest,
    prompt: "Do the thing.",
    source: "local",
  };
}

/** Freeze like the pipeline does, then build the run bundle from that freeze. */
async function freezeAndBuild(
  ctx: TestContext,
  a: LoadedPackage,
  dependencyOverrides: Record<string, string> | null = null,
) {
  const integrationVersions = await freezeRunSpawnDependencies({
    agent: a,
    orgId: ctx.orgId,
    dependencyOverrides,
  });
  const { zip } = await buildAgentPackage(a, ctx.orgId, {
    integrationVersions,
    dependencyOverrides,
  });
  return { integrationVersions, bundle: readBundleFromBuffer(new Uint8Array(zip)) };
}

function integrationMembers(bundle: Bundle) {
  return [...bundle.packages.values()].filter(
    (p) => (p.manifest as { type?: string }).type === "integration",
  );
}

describe("run bundle — integration members at the frozen version (#2005)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundlever" });
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(INTEG, "9.9.9"),
      draftContent: "# Integ\n\nThe draft documentation.\n",
    });
    await publishIntegration(INTEG, "1.0.0");
    await publishIntegration(INTEG, "1.1.0");
    // The stored draft files carry a stale companion: the draft column wins.
    await uploadPackageFiles("integrations", ctx.orgId, INTEG, {
      "manifest.json": enc(JSON.stringify(integManifest(INTEG, "9.9.9"), null, 2)),
      "INTEGRATION.md": enc("# Integ\n\nStale stored draft file.\n"),
    });
  });

  it("pin ~1.0.0 → member 1.0.0 with 1.0.0's INTEGRATION.md", async () => {
    const { integrationVersions, bundle } = await freezeAndBuild(ctx, agent("~1.0.0"));
    expect(integrationVersions[INTEG]).toEqual({ version: "1.0.0", source: "version" });
    const [member] = integrationMembers(bundle);
    expect(member?.identity).toBe(`${INTEG}@1.0.0`);
    expect(dec(member?.files.get("INTEGRATION.md"))).toBe(docFor("1.0.0"));
  });

  it("override 1.1.0 → member 1.1.0 with 1.1.0's INTEGRATION.md", async () => {
    const { integrationVersions, bundle } = await freezeAndBuild(ctx, agent("~1.0.0"), {
      [INTEG]: "1.1.0",
    });
    expect(integrationVersions[INTEG]).toEqual({ version: "1.1.0", source: "version" });
    const [member] = integrationMembers(bundle);
    expect(member?.identity).toBe(`${INTEG}@1.1.0`);
    expect(dec(member?.files.get("INTEGRATION.md"))).toBe(docFor("1.1.0"));
  });

  it("override draft → member at the draft version with draft_content as INTEGRATION.md", async () => {
    const { integrationVersions, bundle } = await freezeAndBuild(ctx, agent("~1.0.0"), {
      [INTEG]: "draft",
    });
    expect(integrationVersions[INTEG]).toEqual({ version: null, source: "draft" });
    const [member] = integrationMembers(bundle);
    expect(member?.identity).toBe(`${INTEG}@9.9.9`);
    expect(dec(member?.files.get("INTEGRATION.md"))).toBe("# Integ\n\nThe draft documentation.\n");
  });

  it("system integration → member at the system registry's version", async () => {
    const manifest = integManifest(SYS_INTEG, "2.0.0");
    await seedPackage({
      id: SYS_INTEG,
      orgId: null,
      type: "integration",
      source: "system",
      draftManifest: manifest,
    });
    await publishIntegration(SYS_INTEG, "2.0.0");
    const restore = _setSystemPackagesForTesting(
      new Map([
        [
          SYS_INTEG,
          {
            packageId: SYS_INTEG,
            scope: "@sysver",
            name: "integ",
            type: "integration",
            version: "2.0.0",
            manifest,
            zipBuffer: Buffer.alloc(0),
            content: docFor("2.0.0"),
            files: {},
          } satisfies SystemPackageEntry,
        ],
      ]),
    );
    try {
      const { integrationVersions, bundle } = await freezeAndBuild(ctx, agent("*", SYS_INTEG));
      expect(integrationVersions[SYS_INTEG]).toEqual({ version: null, source: "system" });
      const [member] = integrationMembers(bundle);
      expect(member?.identity).toBe(`${SYS_INTEG}@2.0.0`);
      expect(dec(member?.files.get("INTEGRATION.md"))).toBe(docFor("2.0.0"));
    } finally {
      restore();
    }
  });

  it("soft-missing integration (absent from the freeze) → no member, no throw", async () => {
    const { integrationVersions, bundle } = await freezeAndBuild(
      ctx,
      agent("^1.0.0", "@bundlever/nowhere"),
    );
    expect(integrationVersions).toEqual({});
    expect(integrationMembers(bundle)).toEqual([]);
    expect(bundle.packages.size).toBe(1);
  });
});
