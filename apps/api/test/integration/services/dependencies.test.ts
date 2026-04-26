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
  CONFIG_BY_TYPE,
} from "../../../src/services/package-items/index.ts";

const SKILL_CONFIG = CONFIG_BY_TYPE.skill;
const TOOL_CONFIG = CONFIG_BY_TYPE.tool;
import {
  buildDependencies,
  collectAllDepIds,
} from "../../../src/services/package-items/dependencies.ts";

describe("manifest-based dependency resolution", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let appId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "deporg" });
    orgId = org.id;
    orgSlug = org.slug;
    appId = defaultAppId;
  });

  // ── buildDependencies ─────────────────────────────────────

  describe("buildDependencies", () => {
    it("builds dependencies from manifest skills + tools + providers", async () => {
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
        id: `@${orgSlug}/dep-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/dep-tool`,
          version: "2.0.0",
          type: "tool",
          description: "A tool",
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
            tools: { [`@${orgSlug}/dep-tool`]: "^2.0.0" },
          },
        },
      });

      const deps = await buildDependencies(`@${orgSlug}/my-agent`);

      expect(deps).not.toBeNull();
      expect(deps!.skills).toBeDefined();
      expect(deps!.skills![`@${orgSlug}/dep-skill`]).toBe("1.0.0");
      expect(deps!.tools).toBeDefined();
      expect(deps!.tools![`@${orgSlug}/dep-tool`]).toBe("2.0.0");
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
    it("blocks deletion when an agent depends on the tool", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/used-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/used-tool`,
          version: "1.0.0",
          type: "tool",
          description: "A tool",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/consumer-agent`,
        draftManifest: {
          name: `@${orgSlug}/consumer-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Uses the tool",
          dependencies: {
            tools: { [`@${orgSlug}/used-tool`]: "*" },
          },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/used-tool`, TOOL_CONFIG);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("IN_USE");
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0]!.id).toBe(`@${orgSlug}/consumer-agent`);
    });

    it("blocks deletion when a tool depends on the skill (cross-type)", async () => {
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
        id: `@${orgSlug}/consumer-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/consumer-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Tool that uses the skill",
          dependencies: {
            skills: { [`@${orgSlug}/shared-skill`]: "*" },
          },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/shared-skill`, SKILL_CONFIG);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("IN_USE");
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0]!.id).toBe(`@${orgSlug}/consumer-tool`);
    });

    it("allows deletion when no package depends on it", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/lonely-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/lonely-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Unreferenced tool",
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/lonely-tool`, TOOL_CONFIG);

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

      // Tool in our org
      await seedPackage({
        orgId,
        id: `@${orgSlug}/our-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/our-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Our tool",
        },
      });
      // Agent in OTHER org references our tool (shouldn't block our deletion)
      await seedPackage({
        orgId: otherOrg.id,
        id: `@otherorg/their-agent`,
        draftManifest: {
          name: `@otherorg/their-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Other org agent",
          dependencies: { tools: { [`@${orgSlug}/our-tool`]: "*" } },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/our-tool`, TOOL_CONFIG);

      expect(result.ok).toBe(true);
    });
  });

  // ── listOrgItems — usedByAgents count ──────────────────────

  describe("listOrgItems — usedByAgents count", () => {
    it("counts manifest-based dependencies correctly", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/counted-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/counted-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Tool",
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
          dependencies: { tools: { [`@${orgSlug}/counted-tool`]: "*" } },
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
          dependencies: { tools: { [`@${orgSlug}/counted-tool`]: "*" } },
        },
      });

      await installPackage({ orgId: orgId, applicationId: appId }, `@${orgSlug}/counted-tool`);
      const items = await listOrgItems(orgId, TOOL_CONFIG, appId);
      const tool = items.find((i) => i.id === `@${orgSlug}/counted-tool`);

      expect(tool).toBeDefined();
      expect(tool!.usedByAgents).toBe(2);
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

      await installPackage({ orgId: orgId, applicationId: appId }, `@${orgSlug}/unused-skill`);
      const items = await listOrgItems(orgId, SKILL_CONFIG, appId);
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
        id: `@${orgSlug}/detail-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/detail-tool`,
          displayName: "Detail Tool",
          version: "1.0.0",
          type: "tool",
          description: "A tool",
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
          description: "Uses tool",
          dependencies: { tools: { [`@${orgSlug}/detail-tool`]: "*" } },
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/detail-tool`, TOOL_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(1);
      expect(item!.agents[0]!.id).toBe(`@${orgSlug}/using-agent`);
    });

    it("returns empty agents array when unused", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/orphan-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/orphan-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Orphan",
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/orphan-tool`, TOOL_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(0);
    });

    it("includes cross-type dependents (tool depends on skill)", async () => {
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
        id: `@${orgSlug}/dependent-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/dependent-tool`,
          displayName: "Dependent Tool",
          version: "1.0.0",
          type: "tool",
          description: "Tool using skill",
          dependencies: { skills: { [`@${orgSlug}/base-skill`]: "*" } },
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/base-skill`, SKILL_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.agents).toHaveLength(1);
      expect(item!.agents[0]!.id).toBe(`@${orgSlug}/dependent-tool`);
    });
  });

  // ── collectAllDepIds — transitive resolution ──────────────

  describe("collectAllDepIds — transitive resolution", () => {
    it("collects transitive deps (agent → tool → skill)", async () => {
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
        id: `@${orgSlug}/mid-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/mid-tool`,
          version: "1.0.0",
          type: "tool",
          description: "Tool depending on skill",
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
          description: "Agent depending on tool",
          dependencies: { tools: { [`@${orgSlug}/mid-tool`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/top-agent`);

      expect(deps.toolIds).toContain(`@${orgSlug}/mid-tool`);
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
        id: `@${orgSlug}/tool-a`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/tool-a`,
          version: "1.0.0",
          type: "tool",
          description: "Tool A",
          dependencies: { skills: { [`@${orgSlug}/shared-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/tool-b`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/tool-b`,
          version: "1.0.0",
          type: "tool",
          description: "Tool B",
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
            tools: {
              [`@${orgSlug}/tool-a`]: "*",
              [`@${orgSlug}/tool-b`]: "*",
            },
          },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/diamond-agent`);

      expect(deps.toolIds).toHaveLength(2);
      expect(deps.skillIds).toHaveLength(1);
      expect(deps.skillIds).toContain(`@${orgSlug}/shared-skill`);
    });

    it("handles cycles without infinite loop (tool A → tool B → tool A)", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-tool-a`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/cycle-tool-a`,
          version: "1.0.0",
          type: "tool",
          description: "Cycle A",
          dependencies: { tools: { [`@${orgSlug}/cycle-tool-b`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-tool-b`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/cycle-tool-b`,
          version: "1.0.0",
          type: "tool",
          description: "Cycle B",
          dependencies: { tools: { [`@${orgSlug}/cycle-tool-a`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/cycle-agent`,
        draftManifest: {
          name: `@${orgSlug}/cycle-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent with cyclic tools",
          dependencies: { tools: { [`@${orgSlug}/cycle-tool-a`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/cycle-agent`);

      // Both tools collected, no infinite loop
      expect(deps.toolIds).toHaveLength(2);
      expect(deps.toolIds).toContain(`@${orgSlug}/cycle-tool-a`);
      expect(deps.toolIds).toContain(`@${orgSlug}/cycle-tool-b`);
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
      expect(deps.toolIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
    });

    it("returns empty for non-existent package", async () => {
      const deps = await collectAllDepIds("@nonexistent/pkg");

      expect(deps.skillIds).toHaveLength(0);
      expect(deps.toolIds).toHaveLength(0);
      expect(deps.providerIds).toHaveLength(0);
    });
  });
});
