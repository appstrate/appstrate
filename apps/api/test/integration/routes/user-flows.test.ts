// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedPackage } from "../../helpers/seed.ts";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { asRecord } from "../../../src/lib/safe-json.ts";

const app = getTestApp();

describe("User Flows API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("DELETE /api/packages/flows/:scope/:name", () => {
    // NOTE: DELETE flow calls S3 to remove artifacts — returns 500 without real S3.
    // These tests verify auth/guard behavior only. Full delete tests require MinIO.
    it("returns 401 without auth on delete", async () => {
      const res = await app.request("/api/packages/flows/@myorg/some-flow", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/flows/:scope/:name/skills", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@myorg/test-flow/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/flows/@myorg/nonexistent/skills", {
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
      await seedFlow({
        id: "@myorg/skills-flow",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/skills-flow",
          version: "0.1.0",
          type: "flow",
          description: "Flow",
          dependencies: { tools: { "@appstrate/log": "*" } },
        },
      });

      const res = await app.request("/api/flows/@myorg/skills-flow/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: ["@myorg/skill-a"] }),
      });

      expect(res.status).toBe(200);

      // Verify manifest was updated
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/skills-flow"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.skills).toEqual({ "@myorg/skill-a": "*" });
      // Tools should be preserved
      expect(deps.tools).toEqual({ "@appstrate/log": "*" });
    });

    it("clears skills when empty array", async () => {
      await seedFlow({
        id: "@myorg/clear-flow",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/clear-flow",
          version: "0.1.0",
          type: "flow",
          description: "Flow",
          dependencies: { skills: { "@myorg/old-skill": "*" } },
        },
      });

      const res = await app.request("/api/flows/@myorg/clear-flow/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(200);

      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/clear-flow"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.skills).toEqual({});
    });
  });

  describe("PUT /api/flows/:scope/:name/tools", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@myorg/test-flow/tools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/flows/@myorg/nonexistent/tools", {
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
      await seedFlow({
        id: "@myorg/tools-flow",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@myorg/tools-flow",
          version: "0.1.0",
          type: "flow",
          description: "Flow",
          dependencies: { skills: { "@myorg/existing-skill": "*" } },
        },
      });

      const res = await app.request("/api/flows/@myorg/tools-flow/tools", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ toolIds: ["@myorg/tool-x"] }),
      });

      expect(res.status).toBe(200);

      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@myorg/tools-flow"));
      const m = asRecord(row!.draftManifest);
      const deps = asRecord(m.dependencies);
      expect(deps.tools).toEqual({ "@myorg/tool-x": "*" });
      // Skills should be preserved
      expect(deps.skills).toEqual({ "@myorg/existing-skill": "*" });
    });
  });
});
