// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  listOrgItems,
  getOrgItem,
  deleteOrgItem,
} from "../../../src/services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../../../src/services/package-items/config.ts";

const SKILL_CONFIG = CONFIG_BY_TYPE.skill;
const PROVIDER_CONFIG = CONFIG_BY_TYPE.provider;
import {
  buildDependencies,
  collectAllDepIds,
} from "../../../src/services/package-items/dependencies.ts";

describe("manifest-based dependency resolution", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let applicationId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "deporg" });
    orgId = org.id;
    orgSlug = org.slug;
    applicationId = defaultAppId;
  });

  // ── buildDependencies ─────────────────────────────────────

  describe("buildDependencies", () => {
    it("builds dependencies from manifest skills + providers", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/dep-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/dep-skill`,
          version: "1.0.0",
          type: "skill",
          description: "A skill",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/dep-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/dep-provider`,
          version: "2.0.0",
          type: "provider",
          description: "A provider",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-agent`,
        draftManifest: {
          name: `@${orgSlug}/my-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent with deps",
          dependencies: {
            skills: { [`@${orgSlug}/dep-skill`]: "^1.0.0" },
            providers: { [`@${orgSlug}/dep-provider`]: "^2.0.0" },
          },
        },
      });

      const deps = await buildDependencies(`@${orgSlug}/my-agent`);

      expect(deps).not.toBeNull();
      expect(deps!.skills).toBeDefined();
      expect(deps!.skills![`@${orgSlug}/dep-skill`]).toBe("1.0.0");
      expect(deps!.providers).toBeDefined();
      expect(deps!.providers![`@${orgSlug}/dep-provider`]).toBe("2.0.0");
    });

    it("returns null when package has no dependencies", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/no-deps`,
        draftManifest: {
          name: `@${orgSlug}/no-deps`,
          version: "0.1.0",
          type: "agent",
          description: "No deps",
        },
      });

      const deps = await buildDependencies(`@${orgSlug}/no-deps`);
      expect(deps).toBeNull();
    });

    it("returns null for non-existent package", async () => {
      const deps = await buildDependencies("@nonexistent/pkg");
      expect(deps).toBeNull();
    });
  });

  // ── deleteOrgItem — in-use protection ─────────────────────

  describe("deleteOrgItem — in-use protection", () => {
    it("blocks deletion when an agent depends on the provider", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/used-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/used-provider`,
          version: "1.0.0",
          type: "provider",
          description: "A provider",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/consumer-agent`,
        draftManifest: {
          name: `@${orgSlug}/consumer-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Uses the provider",
          dependencies: {
            providers: { [`@${orgSlug}/used-provider`]: "*" },
          },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/used-provider`, PROVIDER_CONFIG);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("IN_USE");
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0]!.id).toBe(`@${orgSlug}/consumer-agent`);
    });

    it("blocks deletion when a provider depends on the skill (cross-type)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/shared-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/shared-skill`,
          version: "1.0.0",
          type: "skill",
          description: "A skill",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/consumer-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/consumer-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Provider that uses the skill",
          dependencies: {
            skills: { [`@${orgSlug}/shared-skill`]: "*" },
          },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/shared-skill`, SKILL_CONFIG);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("IN_USE");
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0]!.id).toBe(`@${orgSlug}/consumer-provider`);
    });

    it("allows deletion when no package depends on it", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/lonely-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/lonely-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Unreferenced provider",
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/lonely-provider`, PROVIDER_CONFIG);

      expect(result.ok).toBe(true);
    });

    it("blocks deletion when multiple packages depend on it", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/popular-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/popular-skill`,
          version: "1.0.0",
          type: "skill",
          description: "Used by many",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-a`,
        draftManifest: {
          name: `@${orgSlug}/agent-a`,
          version: "0.1.0",
          type: "agent",
          description: "Agent A",
          dependencies: { skills: { [`@${orgSlug}/popular-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-b`,
        draftManifest: {
          name: `@${orgSlug}/agent-b`,
          version: "0.1.0",
          type: "agent",
          description: "Agent B",
          dependencies: { skills: { [`@${orgSlug}/popular-skill`]: "*" } },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/popular-skill`, SKILL_CONFIG);

      expect(result.ok).toBe(false);
      expect(result.dependents).toHaveLength(2);
    });

    it("does not block deletion from a different org's dependencies", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg" });

      // Provider in our org
      await seedPackage({
        orgId,
        id: `@${orgSlug}/our-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/our-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Our provider",
        },
      });
      // Agent in OTHER org references our provider (shouldn't block our deletion)
      await seedPackage({
        orgId: otherOrg.id,
        id: `@otherorg/their-agent`,
        draftManifest: {
          name: `@otherorg/their-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Other org agent",
          dependencies: { providers: { [`@${orgSlug}/our-provider`]: "*" } },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/our-provider`, PROVIDER_CONFIG);

      expect(result.ok).toBe(true);
    });
  });

  // ── listOrgItems — usedByAgents count ──────────────────────

  describe("listOrgItems — usedByAgents count", () => {
    it("counts manifest-based dependencies correctly", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/counted-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/counted-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Provider",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-1`,
        draftManifest: {
          name: `@${orgSlug}/agent-1`,
          version: "0.1.0",
          type: "agent",
          description: "Agent 1",
          dependencies: { providers: { [`@${orgSlug}/counted-provider`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-2`,
        draftManifest: {
          name: `@${orgSlug}/agent-2`,
          version: "0.1.0",
          type: "agent",
          description: "Agent 2",
          dependencies: { providers: { [`@${orgSlug}/counted-provider`]: "*" } },
        },
      });

      await installPackage(
        { orgId: orgId, applicationId: applicationId },
        `@${orgSlug}/counted-provider`,
      );
      const items = await listOrgItems(orgId, PROVIDER_CONFIG, applicationId);
      const provider = items.find((i) => i.id === `@${orgSlug}/counted-provider`);

      expect(provider).toBeDefined();
      expect(provider!.usedByAgents).toBe(2);
    });

    it("returns 0 for unreferenced items", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/unused-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/unused-skill`,
          version: "1.0.0",
          type: "skill",
          description: "Unused",
        },
      });

      await installPackage(
        { orgId: orgId, applicationId: applicationId },
        `@${orgSlug}/unused-skill`,
      );
      const items = await listOrgItems(orgId, SKILL_CONFIG, applicationId);
      const skill = items.find((i) => i.id === `@${orgSlug}/unused-skill`);

      expect(skill).toBeDefined();
      expect(skill!.usedByAgents).toBe(0);
    });
  });

  // ── getOrgItem — dependents list ──────────────────────────

  describe("getOrgItem — dependents list", () => {
    it("returns dependent packages in agents array", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/detail-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/detail-provider`,
          displayName: "Detail Provider",
          version: "1.0.0",
          type: "provider",
          description: "A provider",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/using-agent`,
        draftManifest: {
          name: `@${orgSlug}/using-agent`,
          displayName: "Using Agent",
          version: "0.1.0",
          type: "agent",
          description: "Uses provider",
          dependencies: { providers: { [`@${orgSlug}/detail-provider`]: "*" } },
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/detail-provider`, PROVIDER_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(1);
      expect(item!.agents[0]!.id).toBe(`@${orgSlug}/using-agent`);
    });

    it("returns empty agents array when unused", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/orphan-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/orphan-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Orphan",
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/orphan-provider`, PROVIDER_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(0);
    });

    it("includes cross-type dependents (provider depends on skill)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/base-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/base-skill`,
          version: "1.0.0",
          type: "skill",
          description: "Base skill",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/dependent-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/dependent-provider`,
          displayName: "Dependent Provider",
          version: "1.0.0",
          type: "provider",
          description: "Provider using skill",
          dependencies: { skills: { [`@${orgSlug}/base-skill`]: "*" } },
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/base-skill`, SKILL_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(1);
      expect(item!.agents[0]!.id).toBe(`@${orgSlug}/dependent-provider`);
    });
  });

  // ── collectAllDepIds — transitive resolution ──────────────

  describe("collectAllDepIds — transitive resolution", () => {
    it("collects transitive deps (agent → provider → skill)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/deep-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/deep-skill`,
          version: "1.0.0",
          type: "skill",
          description: "Leaf skill",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/mid-provider`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/mid-provider`,
          version: "1.0.0",
          type: "provider",
          description: "Provider depending on skill",
          dependencies: { skills: { [`@${orgSlug}/deep-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/top-agent`,
        draftManifest: {
          name: `@${orgSlug}/top-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent depending on provider",
          dependencies: { providers: { [`@${orgSlug}/mid-provider`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/top-agent`);

      expect(deps.providerIds).toContain(`@${orgSlug}/mid-provider`);
      expect(deps.skillIds).toContain(`@${orgSlug}/deep-skill`);
    });

    it("handles diamond dependencies (both paths lead to same skill)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/shared-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/shared-skill`,
          version: "1.0.0",
          type: "skill",
          description: "Shared",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/provider-a`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/provider-a`,
          version: "1.0.0",
          type: "provider",
          description: "Provider A",
          dependencies: { skills: { [`@${orgSlug}/shared-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/provider-b`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/provider-b`,
          version: "1.0.0",
          type: "provider",
          description: "Provider B",
          dependencies: { skills: { [`@${orgSlug}/shared-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/diamond-agent`,
        draftManifest: {
          name: `@${orgSlug}/diamond-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Diamond",
          dependencies: {
            providers: {
              [`@${orgSlug}/provider-a`]: "*",
              [`@${orgSlug}/provider-b`]: "*",
            },
          },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/diamond-agent`);

      expect(deps.providerIds).toHaveLength(2);
      expect(deps.skillIds).toHaveLength(1);
      expect(deps.skillIds).toContain(`@${orgSlug}/shared-skill`);
    });

    it("handles cycles without infinite loop (provider A → provider B → provider A)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-provider-a`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/cycle-provider-a`,
          version: "1.0.0",
          type: "provider",
          description: "Cycle A",
          dependencies: { providers: { [`@${orgSlug}/cycle-provider-b`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-provider-b`,
        type: "provider",
        draftManifest: {
          name: `@${orgSlug}/cycle-provider-b`,
          version: "1.0.0",
          type: "provider",
          description: "Cycle B",
          dependencies: { providers: { [`@${orgSlug}/cycle-provider-a`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-agent`,
        draftManifest: {
          name: `@${orgSlug}/cycle-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent with cyclic providers",
          dependencies: { providers: { [`@${orgSlug}/cycle-provider-a`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/cycle-agent`);

      // Both providers collected, no infinite loop
      expect(deps.providerIds).toHaveLength(2);
      expect(deps.providerIds).toContain(`@${orgSlug}/cycle-provider-a`);
      expect(deps.providerIds).toContain(`@${orgSlug}/cycle-provider-b`);
    });

    it("returns empty when package has no dependencies", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/no-deps-agent`,
        draftManifest: {
          name: `@${orgSlug}/no-deps-agent`,
          version: "0.1.0",
          type: "agent",
          description: "No deps",
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/no-deps-agent`);

      expect(deps.skillIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
    });

    it("returns empty for non-existent package", async () => {
      const deps = await collectAllDepIds("@nonexistent/pkg");

      expect(deps.skillIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
    });
  });
});
