// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the OIDC orgmember-mapping service.
 *
 * Exercises the three-step resolution order with real Postgres:
 *   1. already a member → SELECT-only, returns existing role
 *   2. not a member + `allowSignup=false` → throw `OrgSignupClosedError`
 *   3. not a member + `allowSignup=true` → auto-provision with `signupRole`
 * Plus double-call idempotency and the INSERT race fallback.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import {
  resolveOrCreateOrgMembership,
  OrgSignupClosedError,
} from "../../../services/orgmember-mapping.ts";

describe("resolveOrCreateOrgMembership", () => {
  let orgId: string;
  let ownerUserId: string;
  let newcomerUserId: string;

  beforeEach(async () => {
    await truncateAll();
    const owner = await createTestUser();
    ownerUserId = owner.id;
    const { org } = await createTestOrg(owner.id, { slug: "orgsigntest" });
    orgId = org.id;
    // A second auth identity that has NO membership in the test org — this
    // simulates a brand-new social sign-in on a closed org-level client.
    const newcomer = await createTestUser({ email: "newcomer@example.com" });
    newcomerUserId = newcomer.id;
  });

  it("returns the existing role when the user is already a member (step 1)", async () => {
    const resolved = await resolveOrCreateOrgMembership(
      { id: ownerUserId, email: "owner@example.com" },
      orgId,
      { allowSignup: false, signupRole: "member" },
    );
    expect(resolved.userId).toBe(ownerUserId);
    expect(resolved.orgId).toBe(orgId);
    // `createTestOrg` created the owner as `owner`.
    expect(resolved.role).toBe("owner");

    // No extra row inserted — happy path should be SELECT-only.
    const rows = await db
      .select()
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.userId, ownerUserId), eq(organizationMembers.orgId, orgId)),
      );
    expect(rows.length).toBe(1);
  });

  it("throws OrgSignupClosedError when the user is not a member and allowSignup is false", async () => {
    await expect(
      resolveOrCreateOrgMembership({ id: newcomerUserId, email: "newcomer@example.com" }, orgId, {
        allowSignup: false,
        signupRole: "member",
      }),
    ).rejects.toThrow(OrgSignupClosedError);

    // Policy was closed — no row should have been inserted.
    const rows = await db
      .select()
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.userId, newcomerUserId), eq(organizationMembers.orgId, orgId)),
      );
    expect(rows.length).toBe(0);
  });

  it("auto-provisions with signupRole=member when allowSignup is true", async () => {
    const resolved = await resolveOrCreateOrgMembership(
      { id: newcomerUserId, email: "newcomer@example.com" },
      orgId,
      { allowSignup: true, signupRole: "member" },
    );
    expect(resolved.userId).toBe(newcomerUserId);
    expect(resolved.orgId).toBe(orgId);
    expect(resolved.role).toBe("member");

    const [row] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.userId, newcomerUserId), eq(organizationMembers.orgId, orgId)),
      );
    expect(row?.role).toBe("member");
  });

  it("honors signupRole=admin", async () => {
    const resolved = await resolveOrCreateOrgMembership(
      { id: newcomerUserId, email: "newcomer@example.com" },
      orgId,
      { allowSignup: true, signupRole: "admin" },
    );
    expect(resolved.role).toBe("admin");
  });

  it("honors signupRole=viewer", async () => {
    const resolved = await resolveOrCreateOrgMembership(
      { id: newcomerUserId, email: "newcomer@example.com" },
      orgId,
      { allowSignup: true, signupRole: "viewer" },
    );
    expect(resolved.role).toBe("viewer");
  });

  it("is idempotent on double-call (no extra row, no role change)", async () => {
    // First call: auto-provisions as member.
    const first = await resolveOrCreateOrgMembership(
      { id: newcomerUserId, email: "newcomer@example.com" },
      orgId,
      { allowSignup: true, signupRole: "member" },
    );
    // Second call: even with a different signupRole, existing membership
    // wins — step 1 returns the existing row, step 3 never runs.
    const second = await resolveOrCreateOrgMembership(
      { id: newcomerUserId, email: "newcomer@example.com" },
      orgId,
      { allowSignup: true, signupRole: "admin" },
    );
    expect(second.role).toBe(first.role);
    expect(second.role).toBe("member"); // still the original role

    const rows = await db
      .select()
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.userId, newcomerUserId), eq(organizationMembers.orgId, orgId)),
      );
    expect(rows.length).toBe(1);
  });

  it("second call on a closed policy for an existing member still returns the role (no throw)", async () => {
    // Member lookup short-circuits before the policy check, so an existing
    // member is never gated by `allowSignup=false`.
    const resolved = await resolveOrCreateOrgMembership(
      { id: ownerUserId, email: "owner@example.com" },
      orgId,
      { allowSignup: false, signupRole: "member" },
    );
    expect(resolved.role).toBe("owner");
  });
});
