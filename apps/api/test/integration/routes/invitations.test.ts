import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedInvitation } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Invitations API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inviteorg" });
  });


  describe("GET /invite/:token/info (public)", () => {
    it("returns invitation info", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "new@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/info`);

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.email).toBe("new@test.com");
      expect(body.isNewUser).toBe(true);
    });

    it("returns 404 for invalid token", async () => {
      const res = await app.request("/invite/nonexistent-token/info");
      expect(res.status).toBe(404);
    });

    it("returns 410 for expired invitation", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "expired@test.com",
        invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const res = await app.request(`/invite/${inv.token}/info`);
      expect(res.status).toBe(410);
    });
  });

  describe("POST /invite/:token/accept (public)", () => {
    it("accepts invitation for new user", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "joining@test.com",
        invitedBy: ctx.user.id,
      });

      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: "SecurePass123!",
          displayName: "New Member",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.success).toBe(true);
      expect(body.isNewUser).toBe(true);
      expect(body.orgId).toBe(ctx.orgId);
    });

    it("rejects already accepted invitation", async () => {
      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "double@test.com",
        invitedBy: ctx.user.id,
      });

      // Accept first time
      await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "SecurePass123!" }),
      });

      // Try to accept again
      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "SecurePass123!" }),
      });

      expect(res.status).toBe(410);
    });

    it("rejects accept when authenticated user email does not match invitation email", async () => {
      // Create the invited user so the backend takes the "existing user" path
      await createTestUser({ email: "invited@test.com" });

      const inv = await seedInvitation({
        orgId: ctx.orgId,
        email: "invited@test.com",
        invitedBy: ctx.user.id,
      });

      // Create a second user with a different email and get their session cookie
      const otherUser = await createTestUser({ email: "other@test.com" });

      // Try to accept the invitation while authenticated as the wrong user
      const res = await app.request(`/invite/${inv.token}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: otherUser.cookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.code).toBe("email_mismatch");
    });
  });
});
