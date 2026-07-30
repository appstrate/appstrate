// SPDX-License-Identifier: Apache-2.0

/**
 * The pre-deploy audit for the declared-but-empty integration gate
 * (`services/audit-empty-integration-selections.ts`).
 *
 * This is a DEPLOY GATE: its exit code decides whether a rollout proceeds, so
 * mis-attributing a finding is as harmful as missing one. The first version got
 * schedule selectors backwards — it read an absent `version_override` as "draft"
 * when the runtime reads it as "latest published" — and pooled every schedule's
 * `dependency_overrides` before assigning results, so one schedule's finding
 * landed on all of them.
 *
 * Covered here, per the resolution rules in `agent-version-resolver.ts`:
 *   absent → latest published · "published" → latest published · "draft" → draft
 *   exact version · dist-tag · semver range · several schedules, each its own
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedSchedule } from "../../helpers/seed.ts";
import { mcpServerManifest } from "../../helpers/integration-manifests.ts";
import {
  applicationPackages,
  packageDistTags,
  packageVersions,
  packages,
} from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import {
  auditEmptyIntegrationSelections,
  isReachable,
} from "../../../src/services/audit-empty-integration-selections.ts";
import { validateAgentIntegrationSelections } from "../../../src/services/integration-scope-validation.ts";

const INTEGRATION_ID = "@audorg/no-defaults";

/**
 * An integration with a declared surface but NO `default_tools`, so an agent
 * that declares it without a selection resolves to nothing callable.
 */
function integrationManifest(version: string): Record<string, unknown> {
  return {
    type: "integration",
    schema_version: "0.1",
    name: INTEGRATION_ID,
    version,
    display_name: "No defaults",
    source: { kind: "none" },
    auths: {
      primary: {
        type: "oauth2",
        authorization_endpoint: "https://idp/a",
        token_endpoint: "https://idp/t",
        authorized_uris: ["https://api/*"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
    tools_policy: { list_messages: {} },
    _meta: { "dev.appstrate/api": { auths: { primary: {} } } },
  };
}

/** `selection: undefined` inherits nothing → the audit must flag it. */
function agentManifest(id: string, version: string, selection?: string[]): Record<string, unknown> {
  return {
    type: "agent",
    schema_version: "0.2",
    name: id,
    version,
    display_name: "Audited",
    dependencies: { integrations: { [INTEGRATION_ID]: "^1.0.0" } },
    ...(selection
      ? { integrations_configuration: { [INTEGRATION_ID]: { tools: selection } } }
      : {}),
  };
}

describe("auditEmptyIntegrationSelections", () => {
  let ctx: TestContext;
  const AGENT_ID = "@audorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "audorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest("1.0.0"),
    });
    await seedPackageVersion({
      packageId: INTEGRATION_ID,
      version: "1.0.0",
      manifest: integrationManifest("1.0.0"),
    });
  });

  /** Agent whose DRAFT is broken and whose published 1.0.0 is fine. */
  async function seedSplitAgent(): Promise<{ goodVersionId: number }> {
    await seedPackage({
      id: AGENT_ID,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      createdBy: ctx.user.id,
      draftManifest: agentManifest(AGENT_ID, "1.1.0"), // no selection → broken
    });
    const pv = await seedPackageVersion({
      packageId: AGENT_ID,
      version: "1.0.0",
      manifest: agentManifest(AGENT_ID, "1.0.0", ["list_messages"]), // fine
    });
    return { goodVersionId: pv.id };
  }

  it("flags the broken draft and leaves the healthy published version alone", async () => {
    await seedSplitAgent();
    const findings = await auditEmptyIntegrationSelections();
    expect(findings.map((f) => f.artifact)).toEqual(["draft"]);
    expect(findings[0]?.integrationId).toBe(INTEGRATION_ID);
  });

  it("an unreachable finding does not gate the rollout", async () => {
    await seedSplitAgent();
    const findings = await auditEmptyIntegrationSelections();
    // Nothing installed, no schedule — reported, but not blocking.
    expect(findings.filter(isReachable)).toHaveLength(0);
  });

  it("an UNPINNED install reaches the draft and is therefore blocking", async () => {
    await seedSplitAgent();
    await db
      .insert(applicationPackages)
      .values({ applicationId: ctx.defaultAppId, packageId: AGENT_ID, versionId: null });

    const findings = await auditEmptyIntegrationSelections();
    const reachable = findings.filter(isReachable);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.artifact).toBe("draft");
    expect(reachable[0]?.installedIn).toEqual([ctx.defaultAppId]);
  });

  it("an install PINNED to a healthy version can still run the broken draft", async () => {
    const { goodVersionId } = await seedSplitAgent();
    await db
      .insert(applicationPackages)
      .values({ applicationId: ctx.defaultAppId, packageId: AGENT_ID, versionId: goodVersionId });

    const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.artifact).toBe("draft");
    expect(reachable[0]?.installedIn).toEqual([ctx.defaultAppId]);
  });

  it("flags a non-empty inherited selection when hidden_tools removes every tool", async () => {
    const serverId = "@audorg/hidden-server";
    const serverManifest = {
      ...mcpServerManifest({ name: serverId, version: "1.0.0" }),
      tools: [{ name: "list_messages" }],
    };
    await seedPackage({
      id: serverId,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: serverManifest,
    });
    await seedPackageVersion({
      packageId: serverId,
      version: "1.0.0",
      manifest: serverManifest,
    });
    const baseIntegration = integrationManifest("1.0.0");
    delete baseIntegration._meta;
    const hidden = {
      ...baseIntegration,
      source: { kind: "local", server: { name: serverId, version: "^1.0.0" } },
      default_tools: ["list_messages"],
      hidden_tools: ["list_messages"],
    };
    await db.update(packages).set({ draftManifest: hidden }).where(eq(packages.id, INTEGRATION_ID));
    await db
      .update(packageVersions)
      .set({ manifest: hidden })
      .where(
        and(eq(packageVersions.packageId, INTEGRATION_ID), eq(packageVersions.version, "1.0.0")),
      );
    await seedSplitAgent();
    await db
      .insert(applicationPackages)
      .values({ applicationId: ctx.defaultAppId, packageId: AGENT_ID, versionId: null });

    const validationErrors = await validateAgentIntegrationSelections({
      manifest: agentManifest(AGENT_ID, "1.1.0"),
      orgId: ctx.orgId,
      requireCallableTools: true,
    });
    expect(validationErrors.map((e) => e.code)).toContain("no_tools_selected");

    const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
    expect(reachable.map((f) => f.artifact).sort()).toEqual(["1.0.0", "draft"]);
    expect(reachable.every((f) => f.integrationId === INTEGRATION_ID)).toBe(true);
  });

  describe("schedule version_override resolution", () => {
    async function scheduleWith(
      versionOverride: string | null,
      dependencyOverrides?: Record<string, string>,
    ): Promise<string> {
      const schedule = await seedSchedule({
        packageId: AGENT_ID,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        enabled: true,
        ...(versionOverride === null ? {} : { versionOverride }),
        ...(dependencyOverrides ? { dependencyOverrides } : {}),
      });
      return schedule.id;
    }

    // Absent and "published" both mean the LATEST PUBLISHED version, never the
    // draft — the rule the first implementation had inverted.
    for (const [label, override] of [
      ["absent", null],
      ["published", "published"],
    ] as const) {
      it(`treats ${label} as the latest published version, not the draft`, async () => {
        await seedSplitAgent();
        await scheduleWith(override);
        const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
        // 1.0.0 is healthy, so a schedule pointed at it is NOT a finding. Were
        // this read as "draft", the broken draft would be reported as blocking.
        expect(reachable).toHaveLength(0);
      });
    }

    it("treats an explicit draft override as the draft", async () => {
      await seedSplitAgent();
      await scheduleWith("draft");
      const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
      expect(reachable).toHaveLength(1);
      expect(reachable[0]?.artifact).toBe("draft");
      expect(reachable[0]?.schedules).toHaveLength(1);
    });

    it("resolves an exact version override", async () => {
      await seedSplitAgent();
      // Publish a BROKEN 2.0.0 and point the schedule straight at it.
      await seedPackageVersion({
        packageId: AGENT_ID,
        version: "2.0.0",
        manifest: agentManifest(AGENT_ID, "2.0.0"),
      });
      await scheduleWith("2.0.0");
      const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
      expect(reachable.map((f) => f.artifact)).toEqual(["2.0.0"]);
    });

    it("resolves a semver RANGE override", async () => {
      await seedSplitAgent();
      await seedPackageVersion({
        packageId: AGENT_ID,
        version: "2.0.0",
        manifest: agentManifest(AGENT_ID, "2.0.0"),
      });
      await scheduleWith("^2");
      const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
      expect(reachable.map((f) => f.artifact)).toEqual(["2.0.0"]);
    });

    it("resolves a DIST-TAG override", async () => {
      await seedSplitAgent();
      const broken = await seedPackageVersion({
        packageId: AGENT_ID,
        version: "2.0.0",
        manifest: agentManifest(AGENT_ID, "2.0.0"),
      });
      await db
        .insert(packageDistTags)
        .values({ packageId: AGENT_ID, tag: "next", versionId: broken.id });
      await scheduleWith("next");
      const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
      expect(reachable.map((f) => f.artifact)).toEqual(["2.0.0"]);
    });

    it("attributes each schedule to its OWN artifact, never pooling them", async () => {
      // Pooling was the second defect: one schedule's finding was attributed to
      // every schedule of the same package.
      await seedSplitAgent();
      await seedPackageVersion({
        packageId: AGENT_ID,
        version: "2.0.0",
        manifest: agentManifest(AGENT_ID, "2.0.0"), // broken
      });
      await scheduleWith("draft"); // broken draft
      await scheduleWith("1.0.0"); // healthy
      await scheduleWith("2.0.0"); // broken

      const findings = await auditEmptyIntegrationSelections();
      const byArtifact = new Map(findings.filter(isReachable).map((f) => [f.artifact, f]));
      expect([...byArtifact.keys()].sort()).toEqual(["2.0.0", "draft"]);
      // Exactly one schedule each — the healthy 1.0.0 schedule contributes to
      // neither, and neither finding collects the other's schedule.
      expect(byArtifact.get("draft")?.schedules).toHaveLength(1);
      expect(byArtifact.get("2.0.0")?.schedules).toHaveLength(1);
    });

    it("judges every schedule with its OWN dependency overrides", async () => {
      const goodPublishedIntegration = {
        ...integrationManifest("1.0.0"),
        default_tools: ["list_messages"],
      };
      await db
        .update(packageVersions)
        .set({ manifest: goodPublishedIntegration })
        .where(
          and(eq(packageVersions.packageId, INTEGRATION_ID), eq(packageVersions.version, "1.0.0")),
        );
      await seedPackage({
        id: AGENT_ID,
        orgId: ctx.orgId,
        type: "agent",
        source: "local",
        createdBy: ctx.user.id,
        draftManifest: agentManifest(AGENT_ID, "1.1.0"),
      });

      const brokenScheduleId = await scheduleWith("draft", { [INTEGRATION_ID]: "draft" });
      await scheduleWith("draft"); // default `^1` resolves the healthy published integration

      const reachable = (await auditEmptyIntegrationSelections()).filter(isReachable);
      expect(reachable).toHaveLength(1);
      expect(reachable[0]?.artifact).toBe("draft");
      expect(reachable[0]?.schedules.map((s) => s.id)).toEqual([brokenScheduleId]);
    });
  });
});
