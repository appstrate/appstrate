// SPDX-License-Identifier: Apache-2.0

/**
 * Agreement lock (#2005): the run bundle carries each integration at EXACTLY
 * the version the run froze, with that version's `INTEGRATION.md` bytes.
 *
 * Every case runs the pipeline's freeze (`freezeRunSpawnDependencies`), then
 * `buildAgentPackage` with the frozen map, and checks the integration member:
 * its identity version is the frozen one and its `INTEGRATION.md` is that
 * version's (or, for a draft override, the draft column). Both share one
 * kickoff manifest cache, as in the pipeline, so the manifest the spawn reads
 * is the one the bundle is checked against: a draft saved between the two is
 * left out of the bundle rather than documenting other tools.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { httpHeaderDelivery } from "../../helpers/integration-manifests.ts";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import { readBundleFromBuffer, type Bundle } from "@appstrate/afps-runtime/bundle";
import { buildAgentPackage } from "../../../src/services/package-storage.ts";
import { freezeRunSpawnDependencies } from "../../../src/services/run-pipeline.ts";
import {
  fetchIntegrationManifest,
  type IntegrationManifestCache,
} from "../../../src/services/integration-service.ts";
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
    auths: {
      api: {
        type: "api_key",
        authorized_uris: ["https://api.example.test/**"],
        credentials: {
          schema: {
            type: "object",
            properties: { api_key: { type: "string" } },
            required: ["api_key"],
          },
        },
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  };
}

const docFor = (version: string) => `# Integ\n\nDocumentation of ${version}.\n`;

function integAfps(id: string, version: string, doc = docFor(version)): Uint8Array {
  return zipSync({
    "manifest.json": enc(JSON.stringify(integManifest(id, version), null, 2)),
    "INTEGRATION.md": enc(doc),
  });
}

/** Publish `version` of `id` with its own INTEGRATION.md (row + version row + stored AFPS). */
async function publishIntegration(id: string, version: string, doc?: string): Promise<void> {
  const manifest = integManifest(id, version);
  const afps = integAfps(id, version, doc);
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
  betweenFreezeAndBundle?: () => Promise<void>,
) {
  const manifestCache: IntegrationManifestCache = new Map();
  const integrationVersions = await freezeRunSpawnDependencies({
    agent: a,
    orgId: ctx.orgId,
    dependencyOverrides,
    manifestCache,
  });
  await betweenFreezeAndBundle?.();
  const { zip } = await buildAgentPackage(a, ctx.orgId, {
    integrationVersions,
    manifestCache,
    dependencyOverrides,
  });
  return {
    integrationVersions,
    manifestCache,
    bundle: readBundleFromBuffer(new Uint8Array(zip)),
  };
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

  it("draft saved after the freeze → member left out, the spawn's manifest untouched", async () => {
    const { manifestCache, bundle } = await freezeAndBuild(
      ctx,
      agent("~1.0.0"),
      { [INTEG]: "draft" },
      async () => {
        await db
          .update(packages)
          .set({
            draftManifest: integManifest(INTEG, "10.0.0"),
            draftContent: "# Integ\n\nDocumentation of other tools.\n",
          })
          .where(eq(packages.id, INTEG));
      },
    );
    const spawned = await fetchIntegrationManifest(INTEG, manifestCache);
    expect(spawned.ok && spawned.manifest.version).toBe("9.9.9");
    expect(integrationMembers(bundle)).toEqual([]);
  });

  it("system integration → the boot registry's archive, even when the stored copy drifted", async () => {
    const manifest = integManifest(SYS_INTEG, "2.0.0");
    await seedPackage({
      id: SYS_INTEG,
      orgId: null,
      type: "integration",
      source: "system",
      draftManifest: manifest,
    });
    // Same version, different bytes in storage: the registry must win.
    await publishIntegration(SYS_INTEG, "2.0.0", "# Integ\n\nStale stored copy.\n");
    const registryAfps = integAfps(SYS_INTEG, "2.0.0");
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
            zipBuffer: Buffer.from(registryAfps),
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
