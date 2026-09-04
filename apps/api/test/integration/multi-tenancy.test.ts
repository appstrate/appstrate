// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-tenancy isolation tests.
 *
 * Verifies that data belonging to org A is never accessible or modifiable by org B.
 * Each test creates two separate orgs with their own users, seeds data in org A,
 * then attempts cross-org access from org B.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../helpers/app.ts";
import { truncateAll } from "../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
  seedPackageVersion,
  seedSpace,
  seedSpaceMember,
} from "../helpers/seed.ts";
import { installPackage } from "../../src/services/space-packages.ts";

const app = getTestApp();

describe("Multi-tenancy isolation", () => {
  let orgA: TestContext;
  let orgB: TestContext;

  beforeEach(async () => {
    await truncateAll();
    orgA = await createTestContext({ orgSlug: "org-a" });
    orgB = await createTestContext({ orgSlug: "org-b" });
  });

  // ─── Space membership does not cross the org boundary ────

  describe("Space membership", () => {
    it("a space role in org A grants nothing in a space of org B", async () => {
      // Membership is per (space, user) and `space_members` carries NO org
      // column, so the org tier is the FK's and the resolver's job. The
      // discriminating shape is ONE user in BOTH orgs, holding a role in a
      // space of A and none in a space of B: the same request, the same
      // permission string, two orgs, two answers.
      const crosser = await createTestUser();
      await addOrgMember(orgA.orgId, crosser.id, "guest");
      await addOrgMember(orgB.orgId, crosser.id, "guest");
      await seedSpaceMember({
        spaceId: orgA.defaultSpaceId,
        userId: crosser.id,
        presetRole: "admin",
      });
      const closedInB = await seedSpace({ orgId: orgB.orgId, visibility: "closed" });

      const read = (ctx: TestContext, spaceId: string) =>
        app.request("/api/agents", {
          headers: authHeaders(
            { ...ctx, user: crosser, cookie: crosser.cookie },
            { "X-Space-Id": spaceId },
          ),
        });

      // Control: the row does let them into org A's space.
      expect((await read(orgA, orgA.defaultSpaceId)).status).toBe(200);
      // …and buys them nothing in a space of org B, where they are a guest
      // with no row of their own.
      expect((await read(orgB, closedInB.id)).status).toBe(403);
    });
  });

  // ─── Package / Agent isolation ───────────────────────────

  describe("Package CRUD", () => {
    it("cannot read another org's agent", async () => {
      await seedAgent({ id: "@org-a/secret-agent", orgId: orgA.orgId });

      const res = await app.request("/api/packages/agents/@org-a/secret-agent", {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(404);
    });

    it("cannot update another org's agent", async () => {
      const pkg = await seedAgent({ id: "@org-a/secret-agent", orgId: orgA.orgId });

      const res = await app.request("/api/packages/agents/@org-a/secret-agent", {
        method: "PUT",
        headers: authHeaders(orgB, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: "Hijacked prompt",
          lock_version: pkg.lockVersion,
        }),
      });

      // 403: requirePackageInOrg rejects cross-org DB ownership before handler runs
      expect([403, 404]).toContain(res.status);
    });

    it("cannot delete another org's agent", async () => {
      await seedAgent({ id: "@org-a/secret-agent", orgId: orgA.orgId });

      const res = await app.request("/api/packages/agents/@org-a/secret-agent", {
        method: "DELETE",
        headers: authHeaders(orgB),
      });

      // 403: requirePackageInOrg rejects cross-org DB ownership before handler runs
      expect([403, 404]).toContain(res.status);
    });

    it("does not leak other org's agents in list", async () => {
      await seedAgent({ id: "@org-a/agent-1", orgId: orgA.orgId });
      await installPackage({ orgId: orgA.orgId, spaceId: orgA.defaultSpaceId }, "@org-a/agent-1");
      await seedAgent({ id: "@org-b/agent-1", orgId: orgB.orgId });
      await installPackage({ orgId: orgB.orgId, spaceId: orgB.defaultSpaceId }, "@org-b/agent-1");

      const resA = await app.request("/api/packages/agents", {
        headers: authHeaders(orgA),
      });
      const resB = await app.request("/api/packages/agents", {
        headers: authHeaders(orgB),
      });

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const bodyA = (await resA.json()) as { object: "list"; data: { id: string }[] };
      const bodyB = (await resB.json()) as { object: "list"; data: { id: string }[] };
      const idsA = bodyA.data.map((i) => i.id);
      const idsB = bodyB.data.map((i) => i.id);
      expect(idsA).toContain("@org-a/agent-1");
      expect(idsA).not.toContain("@org-b/agent-1");
      expect(idsB).toContain("@org-b/agent-1");
      expect(idsB).not.toContain("@org-a/agent-1");
    });
  });

  // ─── Run isolation ───────────────────────────────────────

  describe("Runs", () => {
    it("cannot read another org's run", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      const run = await seedRun({
        packageId: "@org-a/agent",
        orgId: orgA.orgId,
        spaceId: orgA.defaultSpaceId,
        userId: orgA.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(404);
    });

    it("cannot read another org's run logs", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      const run = await seedRun({
        packageId: "@org-a/agent",
        orgId: orgA.orgId,
        spaceId: orgA.defaultSpaceId,
        userId: orgA.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(404);
    });

    it("cannot cancel another org's run", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      const run = await seedRun({
        packageId: "@org-a/agent",
        orgId: orgA.orgId,
        spaceId: orgA.defaultSpaceId,
        userId: orgA.user.id,
        status: "running",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(404);
    });

    it("cannot list another org's agent runs", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      await seedRun({
        packageId: "@org-a/agent",
        orgId: orgA.orgId,
        spaceId: orgA.defaultSpaceId,
        userId: orgA.user.id,
        status: "success",
      });

      const res = await app.request("/api/runs?packageId=@org-a/agent", {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: "list"; data: unknown[] };
      expect(body.data).toHaveLength(0);
    });
  });

  // ─── Version isolation ───────────────────────────────────

  describe("Package versions", () => {
    it("cannot access another org's package versions", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      await seedPackageVersion({ packageId: "@org-a/agent" });

      const res = await app.request("/api/packages/agents/@org-a/agent/versions", {
        headers: authHeaders(orgB),
      });

      // Package not visible to org B — 404 from org-scoped lookup
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        const body = (await res.json()) as { versions: unknown[] };
        expect(body.versions).toHaveLength(0);
      }
    });

    it("cannot delete another org's package version", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });
      await seedPackageVersion({ packageId: "@org-a/agent", version: "1.0.0" });

      const res = await app.request("/api/packages/agents/@org-a/agent/versions/1.0.0", {
        method: "DELETE",
        headers: authHeaders(orgB),
      });

      // 403 (cross-org DB ownership via requirePackageInOrg) or 404
      expect([403, 404]).toContain(res.status);
    });
  });

  // ─── Skill isolation ─────────────────────────────────────

  describe("Skills", () => {
    it("cannot read another org's skill", async () => {
      await seedAgent({
        id: "@org-a/my-skill",
        orgId: orgA.orgId,
        type: "skill",
        draftManifest: {
          name: "@org-a/my-skill",
          version: "1.0.0",
          type: "skill",
        },
      });

      const res = await app.request("/api/packages/skills/@org-a/my-skill", {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── Agent dependency isolation ──────────────────────────

  describe("Agent dependencies", () => {
    it("cannot modify another org's agent skills", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });

      const res = await app.request("/api/agents/@org-a/agent/skills", {
        method: "PUT",
        headers: authHeaders(orgB, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: ["@org-b/evil-skill"] }),
      });

      // requireAgent() guard returns 404 for cross-org
      expect(res.status).toBe(404);
    });
  });

  // ─── Profile batch isolation ─────────────────────────────

  describe("Profile batch lookup", () => {
    it("only returns profiles for members in the same org", async () => {
      const res = await app.request("/api/profiles/batch", {
        method: "POST",
        headers: authHeaders(orgA, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: [orgA.user.id, orgB.user.id] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const returnedIds = body.data.map((p) => p.id);
      expect(returnedIds).toContain(orgA.user.id);
      expect(returnedIds).not.toContain(orgB.user.id);
    });
  });
});
