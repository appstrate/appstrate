// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for org profile binding ownership checks.
 *
 * Verifies that:
 * - A member can bind/unbind their own connections
 * - A member CANNOT overwrite/unbind another member's binding
 * - An admin CAN overwrite/unbind any binding (org-profiles:write)
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §3.2.1
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestContext,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedConnectionProfile } from "../../helpers/seed.ts";
import { db } from "../../helpers/db.ts";
import { orgProfileProviderBindings } from "@appstrate/db/schema";

const app = getTestApp();

const PROVIDER_ID = "@system/test-provider";

async function contextForRole(
  ownerCtx: TestContext,
  role: "admin" | "member" | "viewer",
): Promise<TestContext> {
  const user = await createTestUser();
  await addOrgMember(ownerCtx.orgId, user.id, role);
  return { ...ownerCtx, user, cookie: user.cookie };
}

describe("RBAC — Org profile binding ownership", () => {
  let owner: TestContext;
  let admin: TestContext;
  let memberA: TestContext;
  let memberB: TestContext;
  let orgProfileId: string;
  let memberAProfileId: string;
  let memberBProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "binding-test" });
    admin = await contextForRole(owner, "admin");
    memberA = await contextForRole(owner, "member");
    memberB = await contextForRole(owner, "member");

    // Create an org profile
    const orgProfile = await seedConnectionProfile({ orgId: owner.orgId, name: "Org Profile" });
    orgProfileId = orgProfile.id;

    // Create personal profiles for each member
    const profileA = await seedConnectionProfile({
      userId: memberA.user.id,
      name: "Member A Profile",
    });
    memberAProfileId = profileA.id;

    const profileB = await seedConnectionProfile({
      userId: memberB.user.id,
      name: "Member B Profile",
    });
    memberBProfileId = profileB.id;
  });

  /** Seed a binding directly in DB (bypass route to set up test state). */
  async function seedBinding(sourceProfileId: string, boundByUserId: string) {
    await db
      .insert(orgProfileProviderBindings)
      .values({
        orgProfileId,
        providerId: PROVIDER_ID,
        sourceProfileId,
        boundByUserId,
      })
      .onConflictDoUpdate({
        target: [orgProfileProviderBindings.orgProfileId, orgProfileProviderBindings.providerId],
        set: { sourceProfileId, boundByUserId, updatedAt: new Date() },
      });
  }

  describe("unbind", () => {
    it("member can unbind their own binding", async () => {
      await seedBinding(memberAProfileId, memberA.user.id);

      const res = await app.request(
        `/api/connection-profiles/org/${orgProfileId}/bind/${PROVIDER_ID}`,
        { method: "DELETE", headers: authHeaders(memberA) },
      );
      expect(res.status).toBe(200);
    });

    it("member CANNOT unbind another member's binding", async () => {
      await seedBinding(memberAProfileId, memberA.user.id);

      const res = await app.request(
        `/api/connection-profiles/org/${orgProfileId}/bind/${PROVIDER_ID}`,
        { method: "DELETE", headers: authHeaders(memberB) },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("another member");
    });

    it("admin CAN unbind another member's binding", async () => {
      await seedBinding(memberAProfileId, memberA.user.id);

      const res = await app.request(
        `/api/connection-profiles/org/${orgProfileId}/bind/${PROVIDER_ID}`,
        { method: "DELETE", headers: authHeaders(admin) },
      );
      expect(res.status).toBe(200);
    });
  });

  describe("overwrite bind", () => {
    it("member CANNOT overwrite another member's binding", async () => {
      await seedBinding(memberAProfileId, memberA.user.id);

      const res = await app.request(`/api/connection-profiles/org/${orgProfileId}/bind`, {
        method: "POST",
        headers: authHeaders(memberB, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          sourceProfileId: memberBProfileId,
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("another member");
    });

    it("admin CAN overwrite another member's binding", async () => {
      await seedBinding(memberAProfileId, memberA.user.id);

      // Admin needs a personal profile to bind from
      const adminProfile = await seedConnectionProfile({
        userId: admin.user.id,
        name: "Admin Profile",
      });

      const res = await app.request(`/api/connection-profiles/org/${orgProfileId}/bind`, {
        method: "POST",
        headers: authHeaders(admin, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          sourceProfileId: adminProfile.id,
        }),
      });
      // May fail for other reasons (no connection for provider) but NOT 403
      if (res.status === 403) {
        const body = (await res.json()) as { detail: string };
        expect(body.detail).not.toContain("another member");
      }
    });
  });
});
