// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage } from "../../helpers/seed.ts";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { asRecord } from "../../../src/lib/safe-json.ts";

const app = getTestApp();

describe("User Agents API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("DELETE /api/packages/agents/:scope/:name", () => {
    // NOTE: DELETE agent calls S3 to remove artifacts — returns 500 without real S3.
    // These tests verify auth/guard behavior only. Full delete tests require MinIO.
    it("returns 401 without auth on delete", async () => {
      const res = await app.request("/api/packages/agents/@myorg/some-agent", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/agents/:scope/:name/skills", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@myorg/test-agent/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/agents/@myorg/nonexistent/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(404);
    });

    it("updates skills in manifest", async () => {
      await seedPackage({
        orgId: ctx.orgId,
        id: "@myorg/skill-a",
        type: "skill",
        draftManifest: {
          name: "@myorg/skill-a",
          version: "1.0.0",
          type: "skill",
          description: "Skill A",
        },
      });
      await seedAgent({
        id: "@myorg/skills-agent",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/skills-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent",
          dependencies: { tools: { "@appstrate/log": "*" } },
        },
      });

      const res = await app.request("/api/agents/@myorg/skills-agent/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: ["@myorg/skill-a"] }),
      });

      expect(res.status).toBe(200);

      // Verify manifest was updated
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/skills-agent"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.skills).toEqual({ "@myorg/skill-a": "^1.0.0" });
      // Tools should be preserved (left untouched by the skills PUT)
      expect(deps.tools).toEqual({ "@appstrate/log": "*" });
    });

    it("clears skills when empty array", async () => {
      await seedAgent({
        id: "@myorg/clear-agent",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/clear-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent",
          dependencies: { skills: { "@myorg/old-skill": "*" } },
        },
      });

      const res = await app.request("/api/agents/@myorg/clear-agent/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(200);

      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/clear-agent"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.skills).toEqual({});
    });
  });

  describe("PUT /api/agents/:scope/:name/tools", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@myorg/test-agent/tools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/agents/@myorg/nonexistent/tools", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ toolIds: [] }),
      });

      expect(res.status).toBe(404);
    });

    it("updates tools in manifest and preserves skills", async () => {
      await seedPackage({
        orgId: ctx.orgId,
        id: "@myorg/tool-x",
        type: "tool",
        draftManifest: {
          name: "@myorg/tool-x",
          version: "1.0.0",
          type: "tool",
          description: "Tool X",
        },
      });
      await seedAgent({
        id: "@myorg/tools-agent",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/tools-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent",
          dependencies: { skills: { "@myorg/existing-skill": "*" } },
        },
      });

      const res = await app.request("/api/agents/@myorg/tools-agent/tools", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ toolIds: ["@myorg/tool-x"] }),
      });

      expect(res.status).toBe(200);

      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/tools-agent"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.tools).toEqual({ "@myorg/tool-x": "^1.0.0" });
      // Skills should be preserved (left untouched by the tools PUT)
      expect(deps.skills).toEqual({ "@myorg/existing-skill": "*" });
    });
  });
});
