// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `unlisted` package visibility (issue #848).
 *
 * A package carrying `_meta["dev.appstrate/visibility"].level = "unlisted"`
 * must be excluded from every LISTING surface — the per-type package list
 * routes, the library catalogue, and the chat/get_me hints — while staying
 * fully resolvable by exact id (detail GET). Also covers the assistant-skills
 * index exposed by `/api/me/context`, fed by the real `system-packages/`
 * archives (the shipped copilot / web-search / connector-choice skills).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import { initSystemPackages } from "../../../src/services/system-packages.ts";
import { VISIBILITY_META_NAMESPACE } from "../../../src/lib/package-visibility.ts";

const app = getTestApp();

const UNLISTED_META = { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } };

function skillManifest(id: string, extra?: Record<string, unknown>) {
  return {
    name: id,
    version: "1.0.0",
    type: "skill",
    display_name: `Skill ${id}`,
    description: "A test skill",
    ...extra,
  };
}

/** Seed one listed + one unlisted SYSTEM skill (system = visible in any org). */
async function seedSkillPair() {
  await seedPackage({
    id: "@system/listed-skill",
    orgId: null,
    type: "skill",
    source: "system",
    draftManifest: skillManifest("@system/listed-skill"),
    draftContent: "# Listed skill",
  });
  await seedPackage({
    id: "@system/unlisted-skill",
    orgId: null,
    type: "skill",
    source: "system",
    draftManifest: skillManifest("@system/unlisted-skill", { _meta: UNLISTED_META }),
    draftContent: "# Unlisted skill instructions",
  });
}

describe("Unlisted package visibility", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await seedSkillPair();
  });

  describe("listing surfaces", () => {
    it("GET /api/packages/skills excludes unlisted packages", async () => {
      const res = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = body.data.map((s) => s.id);
      expect(ids).toContain("@system/listed-skill");
      expect(ids).not.toContain("@system/unlisted-skill");
    });

    it("GET /api/library excludes unlisted packages from the catalogue", async () => {
      const res = await app.request("/api/library", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { packages: { skill: Array<{ id: string }> } };
      const ids = body.packages.skill.map((s) => s.id);
      expect(ids).toContain("@system/listed-skill");
      expect(ids).not.toContain("@system/unlisted-skill");
    });

    it("GET /api/me/context excludes unlisted skills from the attach-to-agent hints", async () => {
      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { skills: Array<{ package_id: string }> };
      const ids = body.skills.map((s) => s.package_id);
      expect(ids).toContain("@system/listed-skill");
      expect(ids).not.toContain("@system/unlisted-skill");
    });

    it("GET /api/me/context excludes unlisted agents from the runnable hints", async () => {
      const agentId = "@testorg/unlisted-agent";
      await seedPackage({
        id: agentId,
        orgId: ctx.orgId,
        type: "agent",
        source: "local",
        draftManifest: {
          name: agentId,
          version: "1.0.0",
          type: "agent",
          display_name: "Hidden agent",
          _meta: UNLISTED_META,
        },
      });
      await seedInstalledPackage(ctx.defaultAppId, agentId);

      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: Array<{ package_id: string }> };
      expect(body.agents.map((a) => a.package_id)).not.toContain(agentId);
    });
  });

  describe("exact-id resolution (unlisted ≠ forbidden)", () => {
    it("GET /api/packages/skills/{scope}/{name} returns the unlisted skill with its content", async () => {
      const res = await app.request("/api/packages/skills/@system/unlisted-skill", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; content: string };
      expect(body.id).toBe("@system/unlisted-skill");
      expect(body.content).toBe("# Unlisted skill instructions");
    });
  });

  describe("assistant skills (/api/me/context)", () => {
    it("exposes the shipped unlisted system skills, ungated", async () => {
      // Load the REAL system-packages/ archives — this doubles as a conformance
      // check that the shipped assistant skills carry the unlisted flag.
      await initSystemPackages();

      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        assistant_skills: Array<{ package_id: string; display_name: string; description: string }>;
      };
      const ids = body.assistant_skills.map((s) => s.package_id);
      expect(ids).toContain("@appstrate/copilot");
      expect(ids).toContain("@appstrate/web-search");
      expect(ids).toContain("@appstrate/connector-choice");
      for (const s of body.assistant_skills) {
        expect(s.description.length).toBeGreaterThan(0);
      }
      // Listed system skills never leak into the assistant index.
      expect(ids).not.toContain("@system/listed-skill");
    });
  });
});
