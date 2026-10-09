// SPDX-License-Identifier: Apache-2.0

/**
 * The starter agent a new organization receives is runnable by every surface
 * that executes the latest published version — the CLI's `appstrate run
 * @<scope>/hello-world`, chat, the Claude Code plugin — not only by the
 * dashboard's draft run (#1789).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { validateManifest } from "@appstrate/core/validation";
import { packages } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { provisionDefaultAgentForOrg } from "../../../src/services/default-agent.ts";
import {
  computeHasUnpublishedChanges,
  getExactVersionManifest,
  getLatestVersionCreatedAt,
  getVersionInfo,
  listPackageVersions,
} from "../../../src/services/package-versions.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { isPackageActiveHere } from "../../../src/services/space-packages.ts";

describe("provisionDefaultAgentForOrg", () => {
  let ctx: TestContext;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "starter-org" });
    packageId = `@${ctx.org.slug}/hello-world`;
  });

  const provision = () =>
    provisionDefaultAgentForOrg(ctx.orgId, ctx.org.slug, ctx.user.id, ctx.defaultSpaceId);

  it("publishes the draft's manifest version, 1.0.0, which the latest-published resolver runs", async () => {
    await provision();

    const versions = await listPackageVersions(packageId);
    expect(versions.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(versions[0]!.created_by).toBe(ctx.user.id);
    expect(await getVersionInfo(packageId, ctx.orgId)).toEqual({
      latest_published_version: "1.0.0",
      active_version: "1.0.0",
    });

    const manifest = await getExactVersionManifest(packageId, "1.0.0");
    expect(manifest).toMatchObject({ name: packageId, version: "1.0.0", type: "agent" });
    expect(validateManifest(manifest).valid).toBe(true);

    const [row] = await db
      .select({ source: packages.source, updatedAt: packages.updatedAt })
      .from(packages)
      .where(eq(packages.id, packageId));
    expect(
      computeHasUnpublishedChanges(
        row!.source,
        versions.length,
        row!.updatedAt,
        await getLatestVersionCreatedAt(packageId),
      ),
    ).toBe(false);

    // The default of every run surface (CLI, chat, Claude Code plugin).
    const agent = await getPackage(packageId, ctx.orgId);
    expect(agent).not.toBeNull();
    for (const selector of [undefined, "published"]) {
      const resolved = await resolveAgentRunVersion(agent!, selector);
      expect(resolved.overrideVersionLabel).toBe("1.0.0");
      expect(resolved.agent.prompt).toBe(agent!.prompt);
    }
  });

  it("activates the agent in the default space", async () => {
    await provision();

    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, packageId),
    ).toBe(true);
  });

  it("keeps the draft active in the default space when publishing fails", async () => {
    await provisionDefaultAgentForOrg(ctx.orgId, ctx.org.slug, ctx.user.id, ctx.defaultSpaceId, {
      publish: async () => ({ error: "invalid_version" }),
    });

    expect(await getPackage(packageId, ctx.orgId)).not.toBeNull();
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, packageId),
    ).toBe(true);
    expect(await listPackageVersions(packageId)).toEqual([]);
  });

  it("is a logged no-op when the organization already has it", async () => {
    await provision();
    await provision();

    expect((await listPackageVersions(packageId)).map((v) => v.version)).toEqual(["1.0.0"]);
  });
});
