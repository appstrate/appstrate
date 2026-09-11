// SPDX-License-Identifier: Apache-2.0

/**
 * The two org-membership queries injected into every module's
 * `ModuleInitContext` (`lib/modules/registry.ts`).
 *
 * They replace the single `getOrgAdminEmails`, whose `role IN ('admin','owner')`
 * was a policy decision made in a query: a module asking "who is responsible
 * for this org" got admins too, and a module with its own list of user ids had
 * no way to ask about them at all.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, addOrgMember } from "../../helpers/auth.ts";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";

// Read exactly as a module reads them: off the injected context, not by
// importing the query functions the platform keeps to itself.
const { getOrgOwnerEmails, getOrgMembers } = buildModuleInitContext();

describe("module init-context org queries", () => {
  let orgId: string;
  let ownerEmail: string;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let member: Awaited<ReturnType<typeof createTestUser>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await truncateAll();
    const ctx = await createTestContext();
    orgId = ctx.orgId;
    ownerEmail = ctx.user.email;
    admin = await createTestUser();
    member = await createTestUser();
    outsider = await createTestUser();
    await addOrgMember(orgId, admin.id, "admin");
    await addOrgMember(orgId, member.id, "member");
  });

  describe("getOrgOwnerEmails", () => {
    it("returns owners and nobody else", async () => {
      const emails = await getOrgOwnerEmails(orgId);
      expect(emails).toEqual([ownerEmail]);
      // Discriminating: an admin exists in this org and is deliberately absent.
      expect(emails).not.toContain(admin.email);
      expect(emails).not.toContain(member.email);
    });

    it("includes a second owner", async () => {
      const coOwner = await createTestUser();
      await addOrgMember(orgId, coOwner.id, "owner");
      const emails = await getOrgOwnerEmails(orgId);
      expect(emails.sort()).toEqual([ownerEmail, coOwner.email].sort());
    });

    it("is empty for an org that has none", async () => {
      const other = await createTestContext({ orgSlug: "no-owner-org" });
      const { db } = await import("@appstrate/db/client");
      const { sql } = await import("drizzle-orm");
      await db.execute(
        sql`UPDATE org_members SET role = 'admin' WHERE org_id = ${other.orgId} AND role = 'owner'`,
      );
      expect(await getOrgOwnerEmails(other.orgId)).toEqual([]);
    });
  });

  describe("getOrgMembers", () => {
    it("resolves ids to members with their live role", async () => {
      const rows = await getOrgMembers(orgId, [admin.id, member.id]);
      const byId = new Map(rows.map((r) => [r.userId, r]));
      expect(rows).toHaveLength(2);
      expect(byId.get(admin.id)).toEqual({
        userId: admin.id,
        email: admin.email,
        role: "admin",
      });
      expect(byId.get(member.id)?.role).toBe("member");
    });

    it("omits an id that is not a member, rather than throwing", async () => {
      const rows = await getOrgMembers(orgId, [member.id, outsider.id]);
      expect(rows.map((r) => r.userId)).toEqual([member.id]);
    });

    it("omits a member of ANOTHER org asked about through this one", async () => {
      const other = await createTestContext({ orgSlug: "other-org-queries" });
      const rows = await getOrgMembers(orgId, [other.user.id]);
      expect(rows).toEqual([]);
      // Control: the same id resolves in the org they actually belong to.
      expect((await getOrgMembers(other.orgId, [other.user.id])).map((r) => r.userId)).toEqual([
        other.user.id,
      ]);
    });

    it("short-circuits an empty list", async () => {
      expect(await getOrgMembers(orgId, [])).toEqual([]);
    });
  });
});
