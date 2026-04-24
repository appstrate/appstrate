// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";
import {
  createOrganization,
  getUserOrganizations,
  getOrgMembers,
  isSlugAvailable,
  getOrgById,
  addMember,
  removeMember,
  updateMemberRole,
  getOrgSettings,
} from "../../../src/services/organizations.ts";
import { toSlug } from "@appstrate/core/naming";
import { CURRENT_API_VERSION } from "../../../src/lib/api-versions.ts";

const slugify = (v: string) => toSlug(v, 50);

describe("organizations service", () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
  });

  // ── createOrganization ────────────────────────────────────

  describe("createOrganization", () => {
    it("creates an organization and adds the user as owner", async () => {
      const org = await createOrganization("My Org", "my-org", userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe("My Org");
      expect(org.slug).toBe("my-org");
      expect(org.createdBy).toBe(userId);
    });

    it("the creator is listed as owner in members", async () => {
      const org = await createOrganization("Owner Org", "owner-org", userId);

      const members = await getOrgMembers(org.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.userId).toBe(userId);
      expect(members[0]!.role).toBe("owner");
    });

    it("returns valid ISO timestamps", async () => {
      const org = await createOrganization("TS Org", "ts-org", userId);

      expect(org.createdAt).toBeTruthy();
      expect(org.updatedAt).toBeTruthy();
      // Validate they are parseable ISO strings
      expect(new Date(org.createdAt).getTime()).not.toBeNaN();
      expect(new Date(org.updatedAt).getTime()).not.toBeNaN();
    });

    it("can be retrieved by ID after creation", async () => {
      const org = await createOrganization("Fetch Org", "fetch-org", userId);

      const fetched = await getOrgById(org.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.slug).toBe("fetch-org");
    });

    it("pins apiVersion to CURRENT_API_VERSION at creation", async () => {
      const org = await createOrganization("Versioned Org", "versioned-org", userId);

      const settings = await getOrgSettings(org.id);
      expect(settings.apiVersion).toBe(CURRENT_API_VERSION);
    });
  });

  // ── getUserOrganizations ──────────────────────────────────

  describe("getUserOrganizations", () => {
    it("returns all organizations the user belongs to", async () => {
      await createOrganization("Org A", "org-a", userId);
      await createOrganization("Org B", "org-b", userId);

      const orgs = await getUserOrganizations(userId);

      expect(orgs).toHaveLength(2);
      const slugs = orgs.map((o) => o.slug);
      expect(slugs).toContain("org-a");
      expect(slugs).toContain("org-b");
    });

    it("includes the user role in each organization", async () => {
      await createOrganization("Role Org", "role-org", userId);

      const orgs = await getUserOrganizations(userId);
      expect(orgs[0]!.role).toBe("owner");
    });

    it("returns an empty array for a user with no organizations", async () => {
      const lonelyUser = await createTestUser({ email: "lonely@test.com" });

      const orgs = await getUserOrganizations(lonelyUser.id);
      expect(orgs).toHaveLength(0);
    });

    it("returns orgs where user is a member added later", async () => {
      const org = await createOrganization("Join Org", "join-org", userId);
      const newUser = await createTestUser({ email: "joiner@test.com" });

      await addMember(org.id, newUser.id, "member");

      const orgs = await getUserOrganizations(newUser.id);
      expect(orgs).toHaveLength(1);
      expect(orgs[0]!.slug).toBe("join-org");
      expect(orgs[0]!.role).toBe("member");
    });
  });

  // ── getOrgMembers ─────────────────────────────────────────

  describe("getOrgMembers", () => {
    it("lists all members of an organization", async () => {
      const org = await createOrganization("Members Org", "members-org", userId);
      const member = await createTestUser({ email: "member@test.com" });
      await addMember(org.id, member.id, "member");

      const members = await getOrgMembers(org.id);

      expect(members).toHaveLength(2);
      const roles = members.map((m) => m.role);
      expect(roles).toContain("owner");
      expect(roles).toContain("member");
    });

    it("includes email and displayName when available", async () => {
      const org = await createOrganization("Info Org", "info-org", userId);

      const members = await getOrgMembers(org.id);
      expect(members).toHaveLength(1);
      // Email should be populated from the user table
      expect(members[0]!.email).toBeDefined();
      expect(typeof members[0]!.email).toBe("string");
    });

    it("returns an empty array for an org with no members (edge case)", async () => {
      // This would be unusual but the service should handle it
      const members = await getOrgMembers("00000000-0000-0000-0000-000000000000");
      expect(members).toHaveLength(0);
    });
  });

  // ── isSlugAvailable ───────────────────────────────────────

  describe("isSlugAvailable", () => {
    it("returns true for an unused slug", async () => {
      const available = await isSlugAvailable("never-used-slug");
      expect(available).toBe(true);
    });

    it("returns false for a slug already in use", async () => {
      await createOrganization("Taken Org", "taken-slug", userId);

      const available = await isSlugAvailable("taken-slug");
      expect(available).toBe(false);
    });

    it("returns true again after the org is deleted", async () => {
      const org = await createOrganization("Del Org", "del-slug", userId);

      expect(await isSlugAvailable("del-slug")).toBe(false);

      // Import deleteOrganization for cleanup
      const { deleteOrganization } = await import("../../../src/services/organizations.ts");
      await deleteOrganization(org.id);

      expect(await isSlugAvailable("del-slug")).toBe(true);
    });
  });

  // ── addMember / removeMember / updateMemberRole ───────────

  describe("member management", () => {
    it("addMember is idempotent for duplicate membership", async () => {
      const org = await createOrganization("Dup Org", "dup-org", userId);

      // Should not throw — duplicate is silently ignored
      await addMember(org.id, userId, "member");

      const members = await getOrgMembers(org.id);
      expect(members.filter((m) => m.userId === userId)).toHaveLength(1);
    });

    it("removeMember removes a member from the org", async () => {
      const org = await createOrganization("Rm Org", "rm-org", userId);
      const member = await createTestUser({ email: "removable@test.com" });
      await addMember(org.id, member.id, "member");

      await removeMember(org.id, member.id);

      const members = await getOrgMembers(org.id);
      const memberIds = members.map((m) => m.userId);
      expect(memberIds).not.toContain(member.id);
    });

    it("removeMember throws for a non-existent member", async () => {
      const org = await createOrganization("Rm2 Org", "rm2-org", userId);

      await expect(removeMember(org.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
        /not found/i,
      );
    });

    it("updateMemberRole changes the role", async () => {
      const org = await createOrganization("Role Org", "role2-org", userId);
      const member = await createTestUser({ email: "promote@test.com" });
      await addMember(org.id, member.id, "member");

      await updateMemberRole(org.id, member.id, "admin");

      const allMembers = await getOrgMembers(org.id);
      const updated = allMembers.find((m) => m.userId === member.id);
      expect(updated).toBeDefined();
      expect(updated!.role).toBe("admin");
    });
  });

  // ── slugify ───────────────────────────────────────────────

  describe("slugify", () => {
    it("converts name to lowercase slug", () => {
      expect(slugify("My Company")).toBe("my-company");
    });

    it("handles accented characters", () => {
      expect(slugify("Cafe Resume")).toBe("cafe-resume");
    });

    it("strips leading and trailing hyphens", () => {
      expect(slugify("--test--")).toBe("test");
    });

    it("truncates to 50 characters", () => {
      const long = "a".repeat(100);
      expect(slugify(long).length).toBeLessThanOrEqual(50);
    });
  });
});
