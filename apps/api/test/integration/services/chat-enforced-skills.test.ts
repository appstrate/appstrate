// SPDX-License-Identifier: Apache-2.0

/**
 * `loadEnforcedChatSkills` — what the chat injects as the space's policy.
 *
 * Active ∧ flagged, sorted by id, at the latest PUBLISHED version whatever the
 * draft says: `content: null` when no version resolves, a rejection when the
 * archive cannot be read.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, packageVersions } from "@appstrate/db/schema";
import { loadEnforcedChatSkills } from "../../../src/services/chat-enforced-skills.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPublishedVersion, seedSpacePackage } from "../../helpers/seed.ts";
import * as storage from "@appstrate/db/storage";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "../../../src/services/package-storage.ts";

let ctx: TestContext;

const load = () => loadEnforcedChatSkills(ctx.orgId, ctx.defaultSpaceId);

async function seedSkill(
  id: string,
  opts: { enforced?: boolean; enabled?: boolean; publish?: boolean } = {},
): Promise<void> {
  await seedPackage({
    id,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: { name: id, version: "1.0.0", type: "skill", display_name: `Name ${id}` },
    draftContent: `published ${id}`,
  });
  await seedSpacePackage(ctx.defaultSpaceId, id, {
    chatEnforced: opts.enforced ?? true,
    enabled: opts.enabled ?? true,
  });
  if (opts.publish ?? true) await seedPublishedVersion(id, "1.0.0");
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "policy" });
});

describe("loadEnforcedChatSkills", () => {
  it("returns the active flagged skills, sorted by id, with their published SKILL.md", async () => {
    await seedSkill("@policy/zeta");
    await seedSkill("@policy/alpha");
    await seedSkill("@policy/chosen-only", { enforced: false });

    expect(await load()).toEqual([
      {
        packageId: "@policy/alpha",
        name: "Name @policy/alpha",
        version: "1.0.0",
        content: "published @policy/alpha",
      },
      {
        packageId: "@policy/zeta",
        name: "Name @policy/zeta",
        version: "1.0.0",
        content: "published @policy/zeta",
      },
    ]);
  });

  it("serves the published content after the draft is edited", async () => {
    await seedSkill("@policy/tone");
    await db
      .update(packages)
      .set({ draftContent: "work in progress" })
      .where(eq(packages.id, "@policy/tone"));
    expect((await load())[0]?.content).toBe("published @policy/tone");
  });

  it("drops a deactivated skill and brings it back on re-activation", async () => {
    await seedSkill("@policy/tone", { enabled: false });
    expect(await load()).toEqual([]);

    await seedSpacePackage(ctx.defaultSpaceId, "@policy/tone", { enabled: true });
    expect((await load()).map((skill) => skill.packageId)).toEqual(["@policy/tone"]);
  });

  it("answers `content: null` once the published versions are deleted", async () => {
    await seedSkill("@policy/tone");
    await db.delete(packageVersions).where(eq(packageVersions.packageId, "@policy/tone"));

    expect(await load()).toEqual([
      { packageId: "@policy/tone", name: "@policy/tone", version: null, content: null },
    ]);
  });

  it("rejects when a published archive cannot be read — the policy fails closed", async () => {
    await seedSkill("@policy/tone");
    await storage.deleteFile(AGENT_PACKAGES_BUCKET, versionZipKey("@policy/tone", "1.0.0"));
    await expect(load()).rejects.toMatchObject({ code: "version_artifact_unavailable" });
  });

  it("does not read another space's flags", async () => {
    await seedSkill("@policy/tone");
    expect(await loadEnforcedChatSkills(ctx.orgId, "spc_elsewhere")).toEqual([]);
  });
});
