// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0053-migrate-runtime-tools.sql` against seeded manifests, and the boot
 * gate that refuses to start until it has run (`assertRuntimeToolsMigrated`).
 *
 * Nothing reads `runtime_tools`: an agent receives `log`, `note`, `pin`, `recall_memory` and
 * `run_history` by declaring `@appstrate/platform`. The script is the whole mechanism that keeps
 * a stored agent's tools, so the rewrite is asserted on its rows, and on the malformed shape it
 * must leave alone.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { assertRuntimeToolsMigrated, unmigratedRuntimeToolsCount } from "../../../src/lib/boot.ts";

const SCRIPT = new URL(
  "../../../../../scripts/migration/0053-migrate-runtime-tools.sql",
  import.meta.url,
).pathname;

/**
 * Run the `BEGIN … COMMIT` script through the raw driver (`db.execute` sends one statement per
 * call). Same helper as `oauth-client-self-service-fold-migration.test.ts`.
 */
async function execScript(source: string): Promise<void> {
  const pglite = getPGliteClient();
  if (pglite) {
    try {
      await pglite.exec(source);
    } catch (error) {
      await pglite.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return;
  }
  const conn = await reservePgConnection();
  if (!conn) throw new Error("no raw database connection available");
  try {
    await conn.sql.unsafe(source);
  } catch (error) {
    await conn.sql.unsafe("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

const AGENT = "@migr/agent";
const MALFORMED = "@migr/malformed";

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

describe("scripts/migration/0053 — runtime_tools moved to @appstrate/platform", () => {
  beforeEach(async () => {
    await truncateAll();
    const orgId = (await createTestContext({ orgSlug: "migr" })).org.id;
    const withTools = agentManifest(AGENT, { runtime_tools: ["log", "output", "pin"] });
    await seedPackage({ id: AGENT, orgId, draftManifest: withTools });
    await seedPackageVersion({ packageId: AGENT, version: "1.0.0", manifest: withTools });
    // `integrations_configuration."@appstrate/platform"` is a scalar: merging the tools
    // object into it would yield an array, so the script leaves the manifest as it is.
    const malformed = agentManifest(MALFORMED, {
      runtime_tools: ["log"],
      integrations_configuration: { "@appstrate/platform": "oops" },
    });
    await seedPackage({ id: MALFORMED, orgId, draftManifest: malformed });
  });

  it("rewrites draft and version, and leaves a non-object platform configuration alone", async () => {
    await execScript(await Bun.file(SCRIPT).text());

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
    }

    const untouched = await draftOf(MALFORMED);
    expect(untouched.runtime_tools).toEqual(["log"]);
    expect(untouched.integrations_configuration).toEqual({ "@appstrate/platform": "oops" });
  });

  it("boot refuses while a stored agent manifest carries runtime_tools", async () => {
    expect(await unmigratedRuntimeToolsCount()).toBe(3);
    await expect(assertRuntimeToolsMigrated(null)).rejects.toThrow(
      /3 stored agent manifest\(s\) still carry runtime_tools[\s\S]*Refusing to boot: run[\s\S]*0053-migrate-runtime-tools\.sql/,
    );

    await execScript(await Bun.file(SCRIPT).text());

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
      /2 stored agent manifest[\s\S]*\/data\/pglite[\s\S]*while it is stopped/,
    );
  });

  it("propagates a failing probe instead of assuming the rewrite ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertRuntimeToolsMigrated(null, () => Promise.reject(boom))).rejects.toThrow(
      boom,
    );
  });
});
