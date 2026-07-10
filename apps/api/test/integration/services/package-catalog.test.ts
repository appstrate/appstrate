// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { getPackage, resolveDeclaredSkills } from "../../../src/services/package-catalog.ts";

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

    // `getPackage` returns the definition only. The declared-skill projection
    // is derived on demand from whatever manifest the caller holds (#878), so
    // it can never be a stale copy of a different definition's closure.
    it("does not eagerly resolve skills onto the loaded package", async () => {
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
      expect(agent).not.toHaveProperty("skills");
    });
  });

  describe("resolveDeclaredSkills", () => {
    async function seedSkill(id: string, displayName: string): Promise<void> {
      await seedPackage({
        orgId,
        id,
        type: "skill",
        draftManifest: {
          name: id,
          display_name: displayName,
          version: "0.1.0",
          type: "skill",
          description: "A test skill",
        },
      });
    }

    function agentManifest(skills: Record<string, string>) {
      return {
        name: `@${orgSlug}/dep-agent`,
        version: "0.1.0",
        type: "agent",
        dependencies: { skills },
      } as unknown as Parameters<typeof resolveDeclaredSkills>[0];
    }

    it("resolves a declared skill and enriches it from the catalog", async () => {
      await seedSkill(`@${orgSlug}/my-skill`, "My Skill");

      const declared = await resolveDeclaredSkills(
        agentManifest({ [`@${orgSlug}/my-skill`]: "^0.1.0" }),
        orgId,
      );

      expect(declared).toHaveLength(1);
      expect(declared[0]!.id).toBe(`@${orgSlug}/my-skill`);
      expect(declared[0]!.resolved).toBe(true);
      expect(declared[0]!.version).toBe("^0.1.0");
      expect(declared[0]!.name).toBe("My Skill");
    });

    // The old projection DROPPED an unresolvable dep. Callers could not tell a
    // missing skill from an undeclared one — display surfaces silently lost it
    // and the readiness gate inferred absence from a shorter array. The entry
    // is now present and flagged.
    it("keeps a declared skill the org cannot see, flagged unresolved", async () => {
      const declared = await resolveDeclaredSkills(
        agentManifest({ "@nonexistent/skill": "*" }),
        orgId,
      );

      expect(declared).toEqual([{ id: "@nonexistent/skill", version: "*", resolved: false }]);
    });

    it("does not resolve a package of the wrong type", async () => {
      await seedPackage({
        orgId,
        id: `@${orgSlug}/not-a-skill`,
        type: "agent",
        draftManifest: { name: `@${orgSlug}/not-a-skill`, version: "0.1.0", type: "agent" },
      });

      const declared = await resolveDeclaredSkills(
        agentManifest({ [`@${orgSlug}/not-a-skill`]: "^0.1.0" }),
        orgId,
      );

      expect(declared[0]!.resolved).toBe(false);
    });

    it("does not resolve a skill owned by another org", async () => {
      const { cookie: _c, ...otherUser } = await createTestUser();
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "foreignorg" });
      await seedPackage({
        orgId: otherOrg.id,
        id: "@foreignorg/leaky-skill",
        type: "skill",
        draftManifest: { name: "@foreignorg/leaky-skill", version: "0.1.0", type: "skill" },
      });

      const declared = await resolveDeclaredSkills(
        agentManifest({ "@foreignorg/leaky-skill": "^0.1.0" }),
        orgId,
      );

      expect(declared[0]!.resolved).toBe(false);
    });

    it("returns an empty array (and reads no rows) when nothing is declared", async () => {
      const declared = await resolveDeclaredSkills(agentManifest({}), orgId);
      expect(declared).toEqual([]);
    });
  });
});
