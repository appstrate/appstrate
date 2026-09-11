// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, spaceMembers, spaces } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedSpace, seedSpaceRole } from "../../../../../../test/helpers/seed.ts";
import { createClient, updateClient } from "../../../services/oauth-admin.ts";
import {
  resolveOrCreateOrgMembership,
  loadClientSignupPolicy,
} from "../../../services/orgmember-mapping.ts";

describe("OIDC signup space assignments", () => {
  let owner: TestContext;
  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "oidc-assignment" });
  });

  function orgClient(
    extra: Partial<Extract<Parameters<typeof createClient>[0], { level: "org" }>> = {},
  ) {
    return createClient({
      level: "org",
      name: "Signup",
      referencedOrgId: owner.orgId,
      redirectUris: ["https://example.com/callback"],
      ...extra,
    });
  }

  it("rejects guest configurations without assignments and admin configurations with them", async () => {
    await expect(orgClient({ signupRole: "guest" })).rejects.toThrow("at least one space");
    await expect(
      orgClient({
        signupRole: "admin",
        signupSpaceAssignments: [{ space_id: owner.defaultSpaceId, preset_role: "viewer" }],
      }),
    ).rejects.toThrow("must be empty");
    expect((await orgClient({ signupRole: "member" })).signupSpaceAssignments).toEqual([]);
  });

  it("persists and updates the policy, including the cached token-mint path", async () => {
    const first = [{ space_id: owner.defaultSpaceId, preset_role: "viewer" as const }];
    const client = await orgClient({ signupRole: "guest", signupSpaceAssignments: first });
    expect(client.signupSpaceAssignments).toEqual(first);
    expect((await loadClientSignupPolicy(client.clientId))?.signupSpaceAssignments).toEqual(first);
    const other = await seedSpace({ orgId: owner.orgId, visibility: "private" });
    const second = [{ space_id: other.id, preset_role: "operator" as const }];
    expect(
      (await updateClient(client.clientId, { signupSpaceAssignments: second }))
        ?.signupSpaceAssignments,
    ).toEqual(second);
    expect((await loadClientSignupPolicy(client.clientId))?.signupSpaceAssignments).toEqual(second);
    await expect(updateClient(client.clientId, { signupSpaceAssignments: [] })).rejects.toThrow(
      "at least one space",
    );
    await expect(updateClient(client.clientId, { signupRole: "admin" })).rejects.toThrow(
      "must be empty",
    );
    expect(
      (await updateClient(client.clientId, { signupRole: "admin", signupSpaceAssignments: [] }))
        ?.signupRole,
    ).toBe("admin");
  });

  it("rejects assignments outside the client's organization or on a space client", async () => {
    const foreign = await createTestContext({ orgSlug: "foreign-assignments" });
    await expect(
      orgClient({
        signupRole: "guest",
        signupSpaceAssignments: [{ space_id: foreign.defaultSpaceId, preset_role: "viewer" }],
      }),
    ).rejects.toThrow("not found in this organization");
    const foreignRole = await seedSpaceRole({ orgId: foreign.orgId });
    await expect(
      orgClient({
        signupRole: "guest",
        signupSpaceAssignments: [
          { space_id: owner.defaultSpaceId, custom_role_id: foreignRole.id },
        ],
      }),
    ).rejects.toThrow("not found in this organization");
    const spaceClient = await createClient({
      level: "space",
      name: "End users",
      referencedSpaceId: owner.defaultSpaceId,
      redirectUris: ["https://example.com/callback"],
    });
    await expect(
      updateClient(spaceClient.clientId, { signupSpaceAssignments: [] }),
    ).rejects.toThrow("org-level clients");
  });

  it("atomically grants exactly the configured roles and never re-grants existing members", async () => {
    const target = await createTestUser();
    const custom = await seedSpaceRole({ orgId: owner.orgId, permissions: ["agents:read"] });
    const other = await seedSpace({ orgId: owner.orgId, visibility: "private" });
    const policy = {
      allowSignup: true,
      signupRole: "guest" as const,
      signupSpaceAssignments: [
        { space_id: owner.defaultSpaceId, preset_role: "viewer" as const },
        { space_id: other.id, custom_role_id: custom.id },
      ],
    };
    expect((await resolveOrCreateOrgMembership(target, owner.orgId, policy)).role).toBe("guest");
    const assigned = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, target.id));
    expect(assigned).toHaveLength(2);
    expect(assigned.find((row) => row.spaceId === other.id)?.customRoleId).toBe(custom.id);
    await db.delete(spaceMembers).where(eq(spaceMembers.userId, target.id));
    await db.delete(spaces).where(eq(spaces.id, other.id));
    expect((await resolveOrCreateOrgMembership(target, owner.orgId, policy)).role).toBe("guest");
    expect(
      await db.select().from(spaceMembers).where(eq(spaceMembers.userId, target.id)),
    ).toHaveLength(0);
  });

  it("a deleted assignment aborts signup without leaving a partial membership", async () => {
    const target = await createTestUser();
    const deleted = await seedSpace({ orgId: owner.orgId });
    const policy = {
      allowSignup: true,
      signupRole: "guest" as const,
      signupSpaceAssignments: [
        { space_id: owner.defaultSpaceId, preset_role: "viewer" as const },
        { space_id: deleted.id, preset_role: "viewer" as const },
      ],
    };
    await db.delete(spaces).where(eq(spaces.id, deleted.id));
    await expect(resolveOrCreateOrgMembership(target, owner.orgId, policy)).rejects.toThrow(
      "signup space assignment",
    );
    expect(
      await db
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, owner.orgId),
            eq(organizationMembers.userId, target.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db.select().from(spaceMembers).where(eq(spaceMembers.userId, target.id)),
    ).toHaveLength(0);
  });
});
