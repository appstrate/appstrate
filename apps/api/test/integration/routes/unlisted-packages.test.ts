// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `unlisted` package visibility (issue #848).
 *
 * A package carrying `_meta["dev.appstrate/visibility"].level = "unlisted"`
 * must be excluded from every LISTING surface — the per-type package list
 * routes, the library catalogue, and the chat/get_me hints — while staying
 * fully resolvable by exact id (detail GET). Also covers the five shipped
 * assistant-skill archives and the progressively disclosed authoring references.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import {
  getSystemPackages,
  initSystemPackages,
  syncSystemPackagesToDb,
} from "../../../src/services/system-packages.ts";
import { VISIBILITY_META_NAMESPACE, isUnlisted } from "../../../src/lib/package-visibility.ts";
import { isAssistantSkill } from "../../../src/services/assistant-skills.ts";

const app = getTestApp();

const UNLISTED_META = { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } };
const EXPECTED_ASSISTANT_SKILLS = [
  "@appstrate/agent-authoring",
  "@appstrate/connector-choice",
  "@appstrate/copilot",
  "@appstrate/skill-authoring",
  "@appstrate/web-search",
];
const SKILL_AUTHORING_REFERENCES = [
  "references/code-review.md",
  "references/content-writing.md",
  "references/crm-update.md",
  "references/customer-research.md",
  "references/data-analysis.md",
  "references/doc-extraction.md",
  "references/email-reply.md",
  "references/incremental-digest.md",
  "references/meeting-prep.md",
  "references/minutes-actions.md",
  "references/sourced-rag.md",
  "references/sourced-research.md",
  "references/sprint-report.md",
  "references/triage-sentiment.md",
];

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

  describe("shipped assistant skills", () => {
    it("marks exactly five system skills independently from visibility", async () => {
      // Load the real archives. Assistant role and unlisted visibility are two
      // separate assertions so one metadata concern cannot stand in for the other.
      await initSystemPackages();
      const assistants = [...getSystemPackages().values()]
        .filter((entry) => entry.type === "skill" && isAssistantSkill(entry.manifest))
        .sort((a, b) => a.packageId.localeCompare(b.packageId));
      const ids = assistants.map((entry) => entry.packageId);
      expect(ids).toEqual(EXPECTED_ASSISTANT_SKILLS);
      for (const entry of assistants) {
        expect(isUnlisted(entry.manifest)).toBe(true);
        expect(String(entry.manifest.description ?? "").length).toBeGreaterThan(0);
      }

      const skillAuthoring = getSystemPackages().get("@appstrate/skill-authoring");
      expect(skillAuthoring).toBeDefined();
      await syncSystemPackagesToDb(new Map([[skillAuthoring!.packageId, skillAuthoring!]]), [
        skillAuthoring!,
      ]);

      const filesRes = await app.request("/api/packages/@appstrate/skill-authoring/files", {
        headers: authHeaders(ctx),
      });
      expect(filesRes.status).toBe(200);
      const filesBody = (await filesRes.json()) as {
        entries: Array<{ path: string; inline?: string }>;
      };
      const referenceEntries = filesBody.entries.filter((entry) =>
        entry.path.startsWith("references/"),
      );
      expect(referenceEntries.map((entry) => entry.path)).toEqual(SKILL_AUTHORING_REFERENCES);
      expect(filesBody.entries.map((entry) => entry.path)).not.toContain("references/INDEX.md");
      expect(filesBody.entries.find((entry) => entry.path === "SKILL.md")?.inline).toContain(
        "[triage et sentiment](references/triage-sentiment.md)",
      );
      expect(
        referenceEntries.find((entry) => entry.path === "references/triage-sentiment.md")?.inline,
      ).toContain("# Triage et classification de tickets");
      for (const entry of referenceEntries) {
        expect(entry.inline?.length ?? 0).toBeGreaterThan(1_500);
      }
      expect(
        referenceEntries.find((entry) => entry.path === "references/triage-sentiment.md")?.inline,
      ).not.toContain("FAQ pure");
    });
  });
});
