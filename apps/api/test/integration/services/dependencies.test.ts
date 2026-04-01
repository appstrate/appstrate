import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  listOrgItems,
  getOrgItem,
  deleteOrgItem,
  SKILL_CONFIG,
  TOOL_CONFIG,
} from "../../../src/services/package-items/index.ts";
import {
  buildDependencies,
  collectAllDepIds,
} from "../../../src/services/package-items/dependencies.ts";

describe("manifest-based dependency resolution", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "deporg" });
    orgId = org.id;
    orgSlug = org.slug;
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
        id: `@${orgSlug}/my-flow`,
        draftManifest: {
          name: `@${orgSlug}/my-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow with deps",
          dependencies: {
            skills: { [`@${orgSlug}/dep-skill`]: "^1.0.0" },
            tools: { [`@${orgSlug}/dep-tool`]: "^2.0.0" },
          },
        },
      });

      const deps = await buildDependencies(`@${orgSlug}/my-flow`);

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
          type: "flow",
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
    it("blocks deletion when a flow depends on the tool", async () => {
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
        id: `@${orgSlug}/consumer-flow`,
        draftManifest: {
          name: `@${orgSlug}/consumer-flow`,
          version: "0.1.0",
          type: "flow",
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
      expect(result.dependents![0]!.id).toBe(`@${orgSlug}/consumer-flow`);
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
        id: `@${orgSlug}/flow-a`,
        draftManifest: {
          name: `@${orgSlug}/flow-a`,
          version: "0.1.0",
          type: "flow",
          description: "Flow A",
          dependencies: { skills: { [`@${orgSlug}/popular-skill`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/flow-b`,
        draftManifest: {
          name: `@${orgSlug}/flow-b`,
          version: "0.1.0",
          type: "flow",
          description: "Flow B",
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
      // Flow in OTHER org references our tool (shouldn't block our deletion)
      await seedPackage({
        orgId: otherOrg.id,
        id: `@otherorg/their-flow`,
        draftManifest: {
          name: `@otherorg/their-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Other org flow",
          dependencies: { tools: { [`@${orgSlug}/our-tool`]: "*" } },
        },
      });

      const result = await deleteOrgItem(orgId, `@${orgSlug}/our-tool`, TOOL_CONFIG);

      expect(result.ok).toBe(true);
    });
  });

  // ── listOrgItems — usedByFlows count ──────────────────────

  describe("listOrgItems — usedByFlows count", () => {
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
        id: `@${orgSlug}/flow-1`,
        draftManifest: {
          name: `@${orgSlug}/flow-1`,
          version: "0.1.0",
          type: "flow",
          description: "Flow 1",
          dependencies: { tools: { [`@${orgSlug}/counted-tool`]: "*" } },
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/flow-2`,
        draftManifest: {
          name: `@${orgSlug}/flow-2`,
          version: "0.1.0",
          type: "flow",
          description: "Flow 2",
          dependencies: { tools: { [`@${orgSlug}/counted-tool`]: "*" } },
        },
      });

      const items = await listOrgItems(orgId, TOOL_CONFIG);
      const tool = items.find((i) => i.id === `@${orgSlug}/counted-tool`);

      expect(tool).toBeDefined();
      expect(tool!.usedByFlows).toBe(2);
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

      const items = await listOrgItems(orgId, SKILL_CONFIG);
      const skill = items.find((i) => i.id === `@${orgSlug}/unused-skill`);

      expect(skill).toBeDefined();
      expect(skill!.usedByFlows).toBe(0);
    });
  });

  // ── getOrgItem — dependents list ──────────────────────────

  describe("getOrgItem — dependents list", () => {
    it("returns dependent packages in flows array", async () => {
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
        id: `@${orgSlug}/using-flow`,
        draftManifest: {
          name: `@${orgSlug}/using-flow`,
          displayName: "Using Flow",
          version: "0.1.0",
          type: "flow",
          description: "Uses tool",
          dependencies: { tools: { [`@${orgSlug}/detail-tool`]: "*" } },
        },
      });

      const item = await getOrgItem(orgId, `@${orgSlug}/detail-tool`, TOOL_CONFIG);

      expect(item).not.toBeNull();
      expect(item!.flows).toHaveLength(1);
      expect(item!.flows[0]!.id).toBe(`@${orgSlug}/using-flow`);
    });

    it("returns empty flows array when unused", async () => {
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
      expect(item!.flows).toHaveLength(0);
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
      expect(item!.flows).toHaveLength(1);
      expect(item!.flows[0]!.id).toBe(`@${orgSlug}/dependent-tool`);
    });
  });

  // ── collectAllDepIds — transitive resolution ──────────────

  describe("collectAllDepIds — transitive resolution", () => {
    it("collects transitive deps (flow → tool → skill)", async () => {
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
        id: `@${orgSlug}/top-flow`,
        draftManifest: {
          name: `@${orgSlug}/top-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow depending on tool",
          dependencies: { tools: { [`@${orgSlug}/mid-tool`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/top-flow`);

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
        id: `@${orgSlug}/diamond-flow`,
        draftManifest: {
          name: `@${orgSlug}/diamond-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Diamond",
          dependencies: {
            tools: {
              [`@${orgSlug}/tool-a`]: "*",
              [`@${orgSlug}/tool-b`]: "*",
            },
          },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/diamond-flow`);

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
        id: `@${orgSlug}/cycle-flow`,
        draftManifest: {
          name: `@${orgSlug}/cycle-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow with cyclic tools",
          dependencies: { tools: { [`@${orgSlug}/cycle-tool-a`]: "*" } },
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/cycle-flow`);

      // Both tools collected, no infinite loop
      expect(deps.toolIds).toHaveLength(2);
      expect(deps.toolIds).toContain(`@${orgSlug}/cycle-tool-a`);
      expect(deps.toolIds).toContain(`@${orgSlug}/cycle-tool-b`);
    });

    it("returns empty when package has no dependencies", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/no-deps-flow`,
        draftManifest: {
          name: `@${orgSlug}/no-deps-flow`,
          version: "0.1.0",
          type: "flow",
          description: "No deps",
        },
      });

      const deps = await collectAllDepIds(`@${orgSlug}/no-deps-flow`);

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
