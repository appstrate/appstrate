// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";

describe("package-catalog", () => {
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

    it("resolves skill dependencies from manifest", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/my-skill`,
        type: "skill",
        draftManifest: {
          name: `@${orgSlug}/my-skill`,
          display_name: "My Skill",
          version: "0.1.0",
          type: "skill",
          description: "A test skill",
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
    });

    it("gracefully handles missing dependency packages", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/missing-dep-agent`,
        draftManifest: {
          name: `@${orgSlug}/missing-dep-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent referencing non-existent skill",
          dependencies: {
            skills: { "@nonexistent/skill": "*" },
          },
        },
      });

      const agent = await getPackage(`@${orgSlug}/missing-dep-agent`, orgId);

      expect(agent).not.toBeNull();
      // Missing deps are silently ignored (not in DB -> not resolved)
      expect(agent!.skills).toHaveLength(0);
    });

    it("returns empty skills when no dependencies exist", async () => {
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
    });
  });
});
