import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { listPackages, getPackage } from "../../../src/services/flow-service.ts";

describe("flow-service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
  });

  // ── listPackages ──────────────────────────────────────────

  describe("listPackages", () => {
    it("returns flows belonging to the org", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/flow-a`,
        draftManifest: {
          name: `@${orgSlug}/flow-a`,
          version: "0.1.0",
          type: "flow",
          description: "Flow A",
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
        },
      });

      const flows = await listPackages(orgId);

      expect(flows.length).toBeGreaterThanOrEqual(2);
      const ids = flows.map((f) => f.id);
      expect(ids).toContain(`@${orgSlug}/flow-a`);
      expect(ids).toContain(`@${orgSlug}/flow-b`);
    });

    it("includes system packages (orgId: null) alongside org packages", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/sys-flow",
        source: "system",
        draftManifest: {
          name: "@system/sys-flow",
          version: "1.0.0",
          type: "flow",
          description: "System",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/user-flow`,
        draftManifest: {
          name: `@${orgSlug}/user-flow`,
          version: "0.1.0",
          type: "flow",
          description: "User",
        },
      });

      const flows = await listPackages(orgId);
      const ids = flows.map((f) => f.id);
      expect(ids).toContain("@system/sys-flow");
      expect(ids).toContain(`@${orgSlug}/user-flow`);
    });

    it("does not return packages from other orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg" });

      await seedPackage({
        orgId: otherOrg.id,
        id: "@otherorg/secret-flow",
        draftManifest: {
          name: "@otherorg/secret-flow",
          version: "0.1.0",
          type: "flow",
          description: "Other",
        },
      });

      const flows = await listPackages(orgId);
      const ids = flows.map((f) => f.id);
      expect(ids).not.toContain("@otherorg/secret-flow");
    });

    it("only returns packages of type flow", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-flow`,
        type: "flow",
        draftManifest: {
          name: `@${orgSlug}/my-flow`,
          version: "0.1.0",
          type: "flow",
          description: "A flow",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/my-skill`,
          version: "0.1.0",
          type: "skill",
          description: "A skill",
        },
      });

      const flows = await listPackages(orgId);
      const ids = flows.map((f) => f.id);
      expect(ids).toContain(`@${orgSlug}/my-flow`);
      expect(ids).not.toContain(`@${orgSlug}/my-skill`);
    });

    it("returns an empty array when no flows exist", async () => {
      const flows = await listPackages(orgId);
      expect(flows).toBeArray();
      expect(flows).toHaveLength(0);
    });
  });

  // ── getPackage ────────────────────────────────────────────

  describe("getPackage", () => {
    it("returns a loaded flow with manifest and prompt", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/detail-flow`,
        draftManifest: {
          name: `@${orgSlug}/detail-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Detail flow",
        },
        draftContent: "You are a helpful assistant.",
      });

      const flow = await getPackage(`@${orgSlug}/detail-flow`, orgId);

      expect(flow).not.toBeNull();
      expect(flow!.id).toBe(`@${orgSlug}/detail-flow`);
      expect(flow!.manifest.name).toBe(`@${orgSlug}/detail-flow`);
      expect(flow!.prompt).toBe("You are a helpful assistant.");
    });

    it("returns null for a non-existent package", async () => {
      const flow = await getPackage("@testorg/does-not-exist", orgId);
      expect(flow).toBeNull();
    });

    it("returns null for a package belonging to another org", async () => {
      const otherUser = await createTestUser({ email: "other2@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg2" });

      await seedPackage({
        orgId: otherOrg.id,
        id: "@otherorg2/private-flow",
        draftManifest: {
          name: "@otherorg2/private-flow",
          version: "0.1.0",
          type: "flow",
          description: "Private",
        },
      });

      const flow = await getPackage("@otherorg2/private-flow", orgId);
      expect(flow).toBeNull();
    });

    it("resolves skill and tool dependencies from manifest", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/my-skill`,
          displayName: "My Skill",
          version: "0.1.0",
          type: "skill",
          description: "A test skill",
        },
      });

      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-tool`,
        type: "tool",
        draftManifest: {
          name: `@${orgSlug}/my-tool`,
          displayName: "My Tool",
          version: "0.1.0",
          type: "tool",
          description: "A test tool",
        },
      });

      await seedPackage({
        orgId,
        id: `@${orgSlug}/dep-flow`,
        draftManifest: {
          name: `@${orgSlug}/dep-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow with deps",
          dependencies: {
            skills: { [`@${orgSlug}/my-skill`]: "^0.1.0" },
            tools: { [`@${orgSlug}/my-tool`]: "^0.1.0" },
          },
        },
        draftContent: "Flow with dependencies",
      });

      // No junction table insert needed — manifest is the source of truth
      const flow = await getPackage(`@${orgSlug}/dep-flow`, orgId);

      expect(flow).not.toBeNull();
      expect(flow!.skills).toHaveLength(1);
      expect(flow!.skills[0]!.id).toBe(`@${orgSlug}/my-skill`);
      expect(flow!.skills[0]!.name).toBe("My Skill");
      expect(flow!.tools).toHaveLength(1);
      expect(flow!.tools[0]!.id).toBe(`@${orgSlug}/my-tool`);
      expect(flow!.tools[0]!.name).toBe("My Tool");
    });

    it("resolves system tool dependencies", async () => {
      // System tools have orgId: null
      await seedPackage({
        orgId: null,
        id: "@appstrate/log",
        type: "tool",
        source: "system",
        draftManifest: {
          name: "@appstrate/log",
          displayName: "Log",
          version: "1.0.0",
          type: "tool",
          description: "Send log messages",
        },
      });

      await seedPackage({
        orgId,
        id: `@${orgSlug}/sys-dep-flow`,
        draftManifest: {
          name: `@${orgSlug}/sys-dep-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow with system tool",
          dependencies: {
            tools: { "@appstrate/log": "*" },
          },
        },
      });

      const flow = await getPackage(`@${orgSlug}/sys-dep-flow`, orgId);

      expect(flow).not.toBeNull();
      expect(flow!.tools).toHaveLength(1);
      expect(flow!.tools[0]!.id).toBe("@appstrate/log");
      expect(flow!.tools[0]!.name).toBe("Log");
    });

    it("gracefully handles missing dependency packages", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/missing-dep-flow`,
        draftManifest: {
          name: `@${orgSlug}/missing-dep-flow`,
          version: "0.1.0",
          type: "flow",
          description: "Flow referencing non-existent tool",
          dependencies: {
            tools: { "@nonexistent/tool": "*" },
          },
        },
      });

      const flow = await getPackage(`@${orgSlug}/missing-dep-flow`, orgId);

      expect(flow).not.toBeNull();
      // Missing deps are silently ignored (not in DB → not resolved)
      expect(flow!.tools).toHaveLength(0);
    });

    it("returns empty skills and tools when no dependencies exist", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/nodep-flow`,
        draftManifest: {
          name: `@${orgSlug}/nodep-flow`,
          version: "0.1.0",
          type: "flow",
          description: "No deps",
        },
      });

      const flow = await getPackage(`@${orgSlug}/nodep-flow`, orgId);

      expect(flow).not.toBeNull();
      expect(flow!.skills).toHaveLength(0);
      expect(flow!.tools).toHaveLength(0);
    });
  });
});
