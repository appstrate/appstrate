// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { orgInvitations } from "@appstrate/db/schema";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedInvitation, seedSpace } from "../../helpers/seed.ts";

const app = getTestApp();

type InvitationBody = { id: string; token: string; space_assignments: SpaceAssignment[] };

function invite(ctx: TestContext, email: string, spaceId = ctx.defaultSpaceId) {
  return app.request(`/api/orgs/${ctx.orgId}/members`, {
    method: "POST",
    headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      role: "guest",
      space_assignments: [{ space_id: spaceId, preset_role: "viewer" }],
    }),
  });
}

describe("Invitation creation preserves pending access", () => {
  beforeEach(truncateAll);

  it("refuses a second space invitation for the same normalized email without changing the first", async () => {
    const ctx = await createTestContext();
    const secondSpace = await seedSpace({ orgId: ctx.orgId, name: "Second" });
    const first = await invite(ctx, "Guest@Example.com");
    expect(first.status).toBe(201);
    const invitation = (await first.json()) as InvitationBody;

    const second = await invite(ctx, "guest@example.com", secondSpace.id);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("invitation_already_pending");
    const stored = await db
      .select()
      .from(orgInvitations)
      .where(eq(orgInvitations.orgId, ctx.orgId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: invitation.id,
      token: invitation.token,
      status: "pending",
      role: "guest",
      spaceAssignments: [{ space_id: ctx.defaultSpaceId, preset_role: "viewer" }],
    });
    expect((await app.request(`/invite/${invitation.token}/info`)).status).toBe(200);
  });

  it("serializes concurrent creates so exactly one valid pending invitation survives", async () => {
    const ctx = await createTestContext();
    const secondSpace = await seedSpace({ orgId: ctx.orgId, name: "Second" });
    const responses = await Promise.all([
      invite(ctx, "concurrent@example.com"),
      invite(ctx, "Concurrent@example.com", secondSpace.id),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const created = (await responses
      .find((response) => response.status === 201)!
      .json()) as InvitationBody;
    const pending = await db
      .select()
      .from(orgInvitations)
      .where(and(eq(orgInvitations.orgId, ctx.orgId), eq(orgInvitations.status, "pending")));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.token).toBe(created.token);
    expect(pending[0]?.spaceAssignments).toEqual(created.space_assignments);
    expect((await app.request(`/invite/${created.token}/info`)).status).toBe(200);
  });

  it("allows a fresh invitation after the previous pending token has expired", async () => {
    const ctx = await createTestContext();
    const expired = await seedInvitation({
      orgId: ctx.orgId,
      email: "expired@example.com",
      invitedBy: ctx.user.id,
      expiresAt: new Date(Date.now() - 1000),
    });
    const response = await invite(ctx, "expired@example.com");
    expect(response.status).toBe(201);
    const created = (await response.json()) as InvitationBody;
    expect(created.token).not.toBe(expired.token);
    const [old] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, expired.id));
    expect(old?.status).toBe("cancelled");
    expect((await app.request(`/invite/${created.token}/info`)).status).toBe(200);
    expect((await app.request(`/invite/${expired.token}/info`)).status).toBe(410);
  });

  it("allows independent invitations for the same email in different organizations", async () => {
    const first = await createTestContext();
    const second = await createTestContext();
    const responses = await Promise.all([
      invite(first, "shared@example.com"),
      invite(second, "shared@example.com"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const pending = await db
      .select()
      .from(orgInvitations)
      .where(eq(orgInvitations.email, "shared@example.com"));
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((row) => row.orgId))).toEqual(new Set([first.orgId, second.orgId]));
    expect(pending.every((row) => row.status === "pending")).toBe(true);
  });
});
