// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0052-migrate-runtime-tools.ts` against seeded manifests, and the boot
 * gate that refuses to start while a manifest still carries `runtime_tools`
 * (`assertRuntimeToolsMigrated`).
 *
 * Nothing reads `runtime_tools`: an agent receives the run tools by declaring
 * `@appstrate/platform`. The script is the whole mechanism that keeps a stored agent's tools, so
 * the rewrite is asserted on its rows, and on the malformed shape it must leave alone.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { assertRuntimeToolsMigrated, unmigratedRuntimeToolsCount } from "../../../src/lib/boot.ts";
import { runMigrateRuntimeTools } from "../../../../../scripts/migration/0052-migrate-runtime-tools.ts";

const AGENT = "@migr/agent";
const MALFORMED = "@migr/malformed";
const OPEN_OUTPUT = "@migr/open-output";
const UNDECLARED = "@migr/undeclared";

function agentManifest(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { name: id, version: "1.0.0", type: "agent", schema_version: "0.2", ...extra };
}

async function draftOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ m: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, id));
  return row!.m as Record<string, unknown>;
}

async function versionOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ m: packageVersions.manifest })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, id));
  return row!.m as Record<string, unknown>;
}

const apply = (lines: string[] = []) =>
  runMigrateRuntimeTools({ apply: true, out: (line) => lines.push(line) });

describe("scripts/migration/0052 — runtime_tools moved to @appstrate/platform", () => {
  beforeEach(async () => {
    await truncateAll();
    const orgId = (await createTestContext({ orgSlug: "migr" })).org.id;
    const withTools = agentManifest(AGENT, {
      runtime_tools: ["log", "output", "pin"],
      output: { schema: { type: "object", properties: { n: { type: "number" } } } },
    });
    await seedPackage({ id: AGENT, orgId, draftManifest: withTools });
    await seedPackageVersion({ packageId: AGENT, version: "1.0.0", manifest: withTools });
    // `integrations_configuration."@appstrate/platform"` is a scalar: merging the tools
    // object into it would yield an array, so the script leaves the manifest as it is.
    const malformed = agentManifest(MALFORMED, {
      runtime_tools: ["log"],
      integrations_configuration: { "@appstrate/platform": "oops" },
    });
    await seedPackage({ id: MALFORMED, orgId, draftManifest: malformed });
    await seedPackage({
      id: OPEN_OUTPUT,
      orgId,
      draftManifest: agentManifest(OPEN_OUTPUT, { runtime_tools: ["output"] }),
    });
    await seedPackage({ id: UNDECLARED, orgId, draftManifest: agentManifest(UNDECLARED, {}) });
  });

  it("rewrites draft and version, and leaves a non-object platform configuration alone", async () => {
    const result = await apply();
    expect(result.version).toEqual({ rewritten: 1, outputSchemaAdded: 0, malformed: [] });
    expect(result.draft).toEqual({
      rewritten: 3,
      outputSchemaAdded: 1,
      malformed: [`${MALFORMED} (draft)`],
    });

    const expected = {
      dependencies: { integrations: { "@appstrate/platform": "^1.0.0" } },
      integrations_configuration: {
        "@appstrate/platform": { tools: ["log", "pin", "recall_memory", "run_history"] },
      },
    };
    for (const m of [await draftOf(AGENT), await versionOf(AGENT)]) {
      expect(m).not.toHaveProperty("runtime_tools");
      expect(m.dependencies).toEqual(expected.dependencies);
      expect(m.integrations_configuration).toEqual(expected.integrations_configuration);
      // A declared schema is the agent's own: never replaced.
      expect(m.output).toEqual({
        schema: { type: "object", properties: { n: { type: "number" } } },
      });
    }

    const untouched = await draftOf(MALFORMED);
    expect(untouched.runtime_tools).toEqual(["log"]);
    expect(untouched.integrations_configuration).toEqual({ "@appstrate/platform": "oops" });
  });

  it("gives an agent that selected `output` without a schema the open schema, so it keeps the tool", async () => {
    await apply();
    const m = await draftOf(OPEN_OUTPUT);
    expect(m).not.toHaveProperty("runtime_tools");
    expect(m.output).toEqual({
      schema: { type: "object", properties: {}, additionalProperties: true },
    });
    expect(m.integrations_configuration).toEqual({
      "@appstrate/platform": { tools: ["recall_memory", "run_history"] },
    });
  });

  it("declares the integration on an agent that never carried runtime_tools", async () => {
    await apply();
    const m = await draftOf(UNDECLARED);
    expect(m.dependencies).toEqual({ integrations: { "@appstrate/platform": "^1.0.0" } });
    expect(m.integrations_configuration).toEqual({
      "@appstrate/platform": { tools: ["recall_memory", "run_history"] },
    });
    expect(m).not.toHaveProperty("output");
  });

  it("writes nothing on a dry run, and nothing on a second apply", async () => {
    const before = await draftOf(AGENT);
    const dry = await runMigrateRuntimeTools({ apply: false, out: () => undefined });
    expect(dry.draft.rewritten).toBe(3);
    expect(await draftOf(AGENT)).toEqual(before);

    await apply();
    const again = await apply();
    expect(again.version.rewritten).toBe(0);
    expect(again.draft.rewritten).toBe(0);
  });

  it("boot refuses while a stored agent manifest carries runtime_tools", async () => {
    expect(await unmigratedRuntimeToolsCount()).toBe(4);
    await expect(assertRuntimeToolsMigrated(null)).rejects.toThrow(
      /4 stored agent manifest\(s\) still carry runtime_tools[\s\S]*Refusing to boot: run[\s\S]*0052-migrate-runtime-tools\.ts --apply/,
    );

    await apply();

    // The malformed manifest is the one the script skips: fixed by hand, the boot passes.
    expect(await unmigratedRuntimeToolsCount()).toBe(1);
    await db
      .update(packages)
      .set({ draftManifest: agentManifest(MALFORMED, {}) })
      .where(eq(packages.id, MALFORMED));
    expect(await assertRuntimeToolsMigrated(null)).toBeUndefined();
  });
});

describe("assertRuntimeToolsMigrated", () => {
  it("returns without throwing once no manifest carries runtime_tools", async () => {
    expect(await assertRuntimeToolsMigrated(null, async () => 0)).toBeUndefined();
  });

  it("names the embedded data directory and asks for the platform to be stopped", async () => {
    await expect(assertRuntimeToolsMigrated("/data/pglite", async () => 2)).rejects.toThrow(
      /2 stored agent manifest[\s\S]*PGLITE_DATA_DIR=\/data\/pglite bun scripts\/migration\/0052[\s\S]*while it is stopped/,
    );
  });

  it("propagates a failing probe instead of assuming the rewrite ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertRuntimeToolsMigrated(null, () => Promise.reject(boom))).rejects.toThrow(
      boom,
    );
  });
});
