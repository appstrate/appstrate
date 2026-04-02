// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { listPackages, getPackage } from "../../../src/services/agent-service.ts";

describe("agent-service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
  });

  // ── listPackages ──────────────────────────────────────────

  describe("listPackages", () => {
    it("returns agents belonging to the org", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-a`,
        draftManifest: {
          name: `@${orgSlug}/agent-a`,
          version: "0.1.0",
          type: "agent",
          description: "Agent A",
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
        },
      });

      const agents = await listPackages(orgId);

      expect(agents.length).toBeGreaterThanOrEqual(2);
      const ids = agents.map((f) => f.id);
      expect(ids).toContain(`@${orgSlug}/agent-a`);
      expect(ids).toContain(`@${orgSlug}/agent-b`);
    });

    it("includes system packages (orgId: null) alongside org packages", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/sys-agent",
        source: "system",
        draftManifest: {
          name: "@system/sys-agent",
          version: "1.0.0",
          type: "agent",
          description: "System",
        },
      });
      await seedPackage({
        orgId,
        id: `@${orgSlug}/user-agent`,
        draftManifest: {
          name: `@${orgSlug}/user-agent`,
          version: "0.1.0",
          type: "agent",
          description: "User",
        },
      });

      const agents = await listPackages(orgId);
      const ids = agents.map((f) => f.id);
      expect(ids).toContain("@system/sys-agent");
      expect(ids).toContain(`@${orgSlug}/user-agent`);
    });

    it("does not return packages from other orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg" });

      await seedPackage({
        orgId: otherOrg.id,
        id: "@otherorg/secret-agent",
        draftManifest: {
          name: "@otherorg/secret-agent",
          version: "0.1.0",
          type: "agent",
          description: "Other",
        },
      });

      const agents = await listPackages(orgId);
      const ids = agents.map((f) => f.id);
      expect(ids).not.toContain("@otherorg/secret-agent");
    });

    it("only returns packages of type agent", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-agent`,
        type: "agent",
        draftManifest: {
          name: `@${orgSlug}/my-agent`,
          version: "0.1.0",
          type: "agent",
          description: "An agent",
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

      const agents = await listPackages(orgId);
      const ids = agents.map((f) => f.id);
      expect(ids).toContain(`@${orgSlug}/my-agent`);
      expect(ids).not.toContain(`@${orgSlug}/my-skill`);
    });

    it("returns an empty array when no agents exist", async () => {
      const agents = await listPackages(orgId);
      expect(agents).toBeArray();
      expect(agents).toHaveLength(0);
    });
  });

  // ── getPackage ────────────────────────────────────────────

  describe("getPackage", () => {
    it("returns a loaded agent with manifest and prompt", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/detail-agent`,
        draftManifest: {
          name: `@${orgSlug}/detail-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Detail agent",
        },
        draftContent: "You are a helpful assistant.",
      });

      const agent = await getPackage(`@${orgSlug}/detail-agent`, orgId);

      expect(agent).not.toBeNull();
      expect(agent!.id).toBe(`@${orgSlug}/detail-agent`);
      expect(agent!.manifest.name).toBe(`@${orgSlug}/detail-agent`);
      expect(agent!.prompt).toBe("You are a helpful assistant.");
    });

    it("returns null for a non-existent package", async () => {
      const agent = await getPackage("@testorg/does-not-exist", orgId);
      expect(agent).toBeNull();
    });

    it("returns null for a package belonging to another org", async () => {
      const otherUser = await createTestUser({ email: "other2@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg2" });

      await seedPackage({
        orgId: otherOrg.id,
        id: "@otherorg2/private-agent",
        draftManifest: {
          name: "@otherorg2/private-agent",
          version: "0.1.0",
          type: "agent",
          description: "Private",
        },
      });

      const agent = await getPackage("@otherorg2/private-agent", orgId);
      expect(agent).toBeNull();
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
        id: `@${orgSlug}/dep-agent`,
        draftManifest: {
          name: `@${orgSlug}/dep-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent with deps",
          dependencies: {
            skills: { [`@${orgSlug}/my-skill`]: "^0.1.0" },
            tools: { [`@${orgSlug}/my-tool`]: "^0.1.0" },
          },
        },
        draftContent: "Agent with dependencies",
      });

      // No junction table insert needed — manifest is the source of truth
      const agent = await getPackage(`@${orgSlug}/dep-agent`, orgId);

      expect(agent).not.toBeNull();
      expect(agent!.skills).toHaveLength(1);
      expect(agent!.skills[0]!.id).toBe(`@${orgSlug}/my-skill`);
      expect(agent!.skills[0]!.name).toBe("My Skill");
      expect(agent!.tools).toHaveLength(1);
      expect(agent!.tools[0]!.id).toBe(`@${orgSlug}/my-tool`);
      expect(agent!.tools[0]!.name).toBe("My Tool");
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
        id: `@${orgSlug}/sys-dep-agent`,
        draftManifest: {
          name: `@${orgSlug}/sys-dep-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent with system tool",
          dependencies: {
            tools: { "@appstrate/log": "*" },
          },
        },
      });

      const agent = await getPackage(`@${orgSlug}/sys-dep-agent`, orgId);

      expect(agent).not.toBeNull();
      expect(agent!.tools).toHaveLength(1);
      expect(agent!.tools[0]!.id).toBe("@appstrate/log");
      expect(agent!.tools[0]!.name).toBe("Log");
    });

    it("gracefully handles missing dependency packages", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/missing-dep-agent`,
        draftManifest: {
          name: `@${orgSlug}/missing-dep-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent referencing non-existent tool",
          dependencies: {
            tools: { "@nonexistent/tool": "*" },
          },
        },
      });

      const agent = await getPackage(`@${orgSlug}/missing-dep-agent`, orgId);

      expect(agent).not.toBeNull();
      // Missing deps are silently ignored (not in DB -> not resolved)
      expect(agent!.tools).toHaveLength(0);
    });

    it("returns empty skills and tools when no dependencies exist", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/nodep-agent`,
        draftManifest: {
          name: `@${orgSlug}/nodep-agent`,
          version: "0.1.0",
          type: "agent",
          description: "No deps",
        },
      });

      const agent = await getPackage(`@${orgSlug}/nodep-agent`, orgId);

      expect(agent).not.toBeNull();
      expect(agent!.skills).toHaveLength(0);
      expect(agent!.tools).toHaveLength(0);
    });
  });
});
