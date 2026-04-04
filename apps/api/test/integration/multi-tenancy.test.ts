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
import { createTestContext, authHeaders, type TestContext } from "../helpers/auth.ts";
import { seedAgent, seedRun, seedPackageVersion } from "../helpers/seed.ts";

const app = getTestApp();

describe("Multi-tenancy isolation", () => {
  let orgA: TestContext;
  let orgB: TestContext;

  beforeEach(async () => {
    await truncateAll();
    orgA = await createTestContext({ orgSlug: "org-a" });
    orgB = await createTestContext({ orgSlug: "org-b" });
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
          lockVersion: pkg.lockVersion,
        }),
      });

      // 403: requireOwnedPackage rejects scope mismatch before handler runs
      expect([403, 404]).toContain(res.status);
    });

    it("cannot delete another org's agent", async () => {
      await seedAgent({ id: "@org-a/secret-agent", orgId: orgA.orgId });

      const res = await app.request("/api/packages/agents/@org-a/secret-agent", {
        method: "DELETE",
        headers: authHeaders(orgB),
      });

      // 403: requireOwnedPackage rejects scope mismatch before handler runs
      expect([403, 404]).toContain(res.status);
    });

    it("does not leak other org's agents in list", async () => {
      await seedAgent({ id: "@org-a/agent-1", orgId: orgA.orgId });
      await seedAgent({ id: "@org-b/agent-1", orgId: orgB.orgId });

      const resA = await app.request("/api/packages/agents", {
        headers: authHeaders(orgA),
      });
      const resB = await app.request("/api/packages/agents", {
        headers: authHeaders(orgB),
      });

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const bodyA = (await resA.json()) as { agents: { id: string }[] };
      const bodyB = (await resB.json()) as { agents: { id: string }[] };
      const idsA = bodyA.agents.map((i) => i.id);
      const idsB = bodyB.agents.map((i) => i.id);
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
        applicationId: orgA.defaultAppId,
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
        applicationId: orgA.defaultAppId,
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
        applicationId: orgA.defaultAppId,
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
        applicationId: orgA.defaultAppId,
        userId: orgA.user.id,
        status: "success",
      });

      const res = await app.request("/api/runs?packageId=@org-a/agent", {
        headers: authHeaders(orgB),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toHaveLength(0);
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

      // 403 (scope mismatch via requireOwnedPackage) or 404
      expect([403, 404]).toContain(res.status);
    });
  });

  // ─── Skill / Tool isolation ──────────────────────────────

  describe("Skills and Tools", () => {
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

    it("cannot read another org's tool", async () => {
      await seedAgent({
        id: "@org-a/my-tool",
        orgId: orgA.orgId,
        type: "tool",
        draftManifest: {
          name: "@org-a/my-tool",
          version: "1.0.0",
          type: "tool",
          entrypoint: "tool.ts",
          tool: { name: "my-tool", description: "Test", inputSchema: { type: "object" } },
        },
      });

      const res = await app.request("/api/packages/tools/@org-a/my-tool", {
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

    it("cannot modify another org's agent tools", async () => {
      await seedAgent({ id: "@org-a/agent", orgId: orgA.orgId });

      const res = await app.request("/api/agents/@org-a/agent/tools", {
        method: "PUT",
        headers: authHeaders(orgB, { "Content-Type": "application/json" }),
        body: JSON.stringify({ toolIds: ["@org-b/evil-tool"] }),
      });

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
      const body = (await res.json()) as { profiles: { id: string }[] };
      const returnedIds = body.profiles.map((p) => p.id);
      expect(returnedIds).toContain(orgA.user.id);
      expect(returnedIds).not.toContain(orgB.user.id);
    });
  });
});
