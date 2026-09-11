// SPDX-License-Identifier: Apache-2.0

/**
 * The AFPS §3.3 SKILL.md gate, one refusal per skill-WRITING surface: JSON
 * create, draft save, publish (which validates the STORED SKILL.md — the bytes
 * that actually get frozen), version restore, the AFPS import and the
 * bare-skill-ZIP fallback that synthesises its own manifest.
 *
 * The rule table itself lives in `packages/afps-shared`; what is asserted here
 * is that each surface runs it, answers the machine-readable code, and writes
 * nothing. The last describe block is the negative control: the LOADER stays
 * lenient, or runs of agents depending on a pre-rule skill break.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages, packageDistTags, packageVersions } from "@appstrate/db/schema";
import { seedPackageVersion } from "../../helpers/seed.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";
import { DbPackageCatalog } from "../../../src/services/run-launcher/db-package-catalog.ts";

const app = getTestApp();

const enc = (s: string) => new TextEncoder().encode(s);

const SKILL_ID = "@fmorg/gate-skill";
const VALID_CONTENT = "---\nname: gate-skill\ndescription: A gated skill.\n---\n\nBody.";

function skillManifest(version = "1.0.0") {
  return {
    name: SKILL_ID,
    version,
    type: "skill",
    schema_version: "0.1",
    display_name: "Gate Skill",
    description: "A gated skill.",
  };
}

interface ProblemBody {
  code?: string;
  detail?: string;
  errors?: { field?: string; code?: string; message?: string }[];
}

async function createSkill(ctx: TestContext, content: string) {
  return app.request("/api/packages/skills", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: skillManifest(), content }),
  });
}

/** One SKILL.md per reason code the gate must answer with. */
const REJECTED: { label: string; content: string; code: string }[] = [
  {
    label: "no frontmatter at all",
    content: "# Just a body",
    code: "skill_missing_frontmatter_name",
  },
  {
    label: "name that breaks the Agent Skills naming rule",
    content: "---\nname: Gate_Skill\ndescription: A gated skill.\n---\nBody.",
    code: "skill_invalid_frontmatter_name",
  },
  {
    label: "duplicate description key",
    content: "---\nname: gate-skill\ndescription: a\ndescription: b\n---\nBody.",
    code: "skill_invalid_frontmatter",
  },
  {
    label: "absent description",
    content: "---\nname: gate-skill\n---\nBody.",
    code: "skill_missing_frontmatter_description",
  },
  {
    label: "description over 1024 characters",
    content: `---\nname: gate-skill\ndescription: ${"d".repeat(1025)}\n---\nBody.`,
    code: "skill_invalid_frontmatter_description",
  },
];

/** Published versions of `packageId`, newest-agnostic. */
async function versionsOf(packageId: string): Promise<string[]> {
  const rows = await db
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
  return rows.map((r) => r.version);
}

describe("skill SKILL.md frontmatter gate (AFPS §3.3)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "fmorg" });
  });

  /**
   * Publish a version of SKILL_ID whose archive carries a §3.3-NON-conforming
   * SKILL.md — an artifact minted before the rule existed. Seeded through the
   * storage + row layer on purpose: the routes now refuse to create one, which
   * is the whole point, so the legacy state has to be planted directly.
   */
  const LEGACY_SKILL_MD = "---\nname: gate-skill\n---\n\nLegacy body.";
  async function publishLegacyVersion(version: string): Promise<Uint8Array> {
    const manifest = { ...skillManifest(version) };
    const afps = zipSync({
      "manifest.json": enc(JSON.stringify(manifest, null, 2)),
      "SKILL.md": enc(LEGACY_SKILL_MD),
    });
    await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(SKILL_ID, version), afps);
    const pv = await seedPackageVersion({
      packageId: SKILL_ID,
      version,
      integrity: computeIntegrity(afps),
      artifactSize: afps.length,
      manifest,
    });
    await db
      .insert(packageDistTags)
      .values({ packageId: SKILL_ID, tag: "latest", versionId: pv.id })
      .onConflictDoUpdate({
        target: [packageDistTags.packageId, packageDistTags.tag],
        set: { versionId: pv.id, updatedAt: new Date() },
      });
    return afps;
  }

  describe("POST /api/packages/skills", () => {
    it("accepts a conforming SKILL.md", async () => {
      const res = await createSkill(ctx, VALID_CONTENT);
      expect(res.status).toBe(201);
    });

    for (const { label, content, code } of REJECTED) {
      it(`rejects ${label} with ${code}`, async () => {
        const res = await createSkill(ctx, content);
        expect(res.status).toBe(400);
        const body = (await res.json()) as ProblemBody;
        expect(body.code).toBe("validation_failed");
        expect(body.errors?.[0]).toMatchObject({ field: "content", code });
        // Nothing was written.
        expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
      });
    }

    it("names the rule it broke in the message", async () => {
      const res = await createSkill(ctx, "---\nname: gate-skill\n---\nBody.");
      const body = (await res.json()) as ProblemBody;
      expect(body.errors?.[0]?.message).toContain("description");
      expect(body.detail).toContain("description");
    });
  });

  describe("PUT /api/packages/skills/{scope}/{name} (draft save)", () => {
    it("refuses a save that would leave the draft unpublishable", async () => {
      const created = await createSkill(ctx, VALID_CONTENT);
      expect(created.status).toBe(201);
      const lockVersion = ((await created.json()) as { lock_version: number }).lock_version;

      const res = await app.request(`/api/packages/skills/${SKILL_ID}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: skillManifest(),
          content: "---\nname: gate-skill\n---\nBody without a description.",
          lock_version: lockVersion,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors?.[0]?.code).toBe("skill_missing_frontmatter_description");

      // The stored draft is untouched.
      const [row] = await db
        .select({ draftContent: packages.draftContent })
        .from(packages)
        .where(eq(packages.id, SKILL_ID));
      expect(row?.draftContent).toBe(VALID_CONTENT);
    });

    it("accepts a save that keeps the frontmatter conforming", async () => {
      const created = await createSkill(ctx, VALID_CONTENT);
      const lockVersion = ((await created.json()) as { lock_version: number }).lock_version;

      const res = await app.request(`/api/packages/skills/${SKILL_ID}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: skillManifest(),
          content: "---\nname: gate-skill\ndescription: A better description.\n---\nBody.",
          lock_version: lockVersion,
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/packages/skills/{scope}/{name}/versions (publish gate)", () => {
    it("refuses to freeze a stored SKILL.md that has no description", async () => {
      expect((await createSkill(ctx, VALID_CONTENT)).status).toBe(201);

      // Seed the failure where it actually lives. The artifact's SKILL.md comes
      // from STORAGE, not from `packages.draft_content` — so a gate reading the
      // column would wave this through and freeze the bad bytes. `draft_content`
      // is deliberately left CONFORMING here: that is the discriminating case.
      await uploadPackageFiles("skills", ctx.orgId, SKILL_ID, {
        "SKILL.md": enc("---\nname: gate-skill\n---\nLegacy stored bytes."),
      });

      const res = await app.request(`/api/packages/skills/${SKILL_ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "1.1.0" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors?.[0]).toMatchObject({
        field: "content",
        code: "skill_missing_frontmatter_description",
      });
      // Nothing was frozen.
      expect(await versionsOf(SKILL_ID)).not.toContain("1.1.0");
    });

    it("publishes when the stored SKILL.md conforms", async () => {
      expect((await createSkill(ctx, VALID_CONTENT)).status).toBe(201);
      await uploadPackageFiles("skills", ctx.orgId, SKILL_ID, {
        "SKILL.md": enc(`${VALID_CONTENT}\n\nMore body.`),
      });

      const res = await app.request(`/api/packages/skills/${SKILL_ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "1.1.0" }),
      });
      expect(res.status).toBe(201);
      expect(await versionsOf(SKILL_ID)).toContain("1.1.0");
    });
  });

  describe("POST /api/packages/skills/{scope}/{name}/versions/{v}/restore", () => {
    it("refuses to put a legacy version's SKILL.md back into the draft", async () => {
      expect((await createSkill(ctx, VALID_CONTENT)).status).toBe(201);
      await publishLegacyVersion("2.0.0");

      const res = await app.request(`/api/packages/skills/${SKILL_ID}/versions/2.0.0/restore`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors?.[0]?.code).toBe("skill_missing_frontmatter_description");

      // The draft is untouched — a refused restore must not half-apply.
      const [row] = await db
        .select({ draftContent: packages.draftContent })
        .from(packages)
        .where(eq(packages.id, SKILL_ID));
      expect(row?.draftContent).toBe(VALID_CONTENT);
    });
  });

  describe("POST /api/packages/import", () => {
    async function importZip(files: Record<string, Uint8Array>, filename: string) {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(zipSync(files))], filename));
      return app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
    }

    it("rejects a full AFPS skill archive whose SKILL.md has no description", async () => {
      const res = await importZip(
        {
          "manifest.json": enc(JSON.stringify(skillManifest())),
          "SKILL.md": enc("---\nname: gate-skill\n---\nBody."),
        },
        "gate-skill.afps",
      );
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as ProblemBody).detail)).toContain("description");
    });

    it("rejects a BARE skill ZIP whose SKILL.md has no description", async () => {
      // No manifest.json — the skill-only fallback synthesizes one, so this is
      // the path `parsePackageZip` never sees.
      const res = await importZip(
        { "SKILL.md": enc("---\nname: gate-skill\n---\nBody.") },
        "s.zip",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.errors?.[0]).toMatchObject({
        field: "file",
        code: "skill_missing_frontmatter_description",
      });
      expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
    });

    it("accepts a bare skill ZIP whose SKILL.md conforms", async () => {
      const res = await importZip({ "SKILL.md": enc(VALID_CONTENT) }, "gate-skill.zip");
      expect(res.status).toBe(201);
    });
  });

  // ── The other half of the contract ──────────────────────────────────
  //
  // Everything above is a WRITE. Reading an already-published skill must be
  // untouched by all of it: bundles are immutable, so tightening the LOADER
  // would fail every run of every agent that depends on a skill published
  // before the rule — for a defect that cannot be fixed in place.
  describe("the loader is NOT gated", () => {
    it("serves a published legacy skill through the run path's catalog", async () => {
      expect((await createSkill(ctx, VALID_CONTENT)).status).toBe(201);
      await publishLegacyVersion("2.0.0");

      // `DbPackageCatalog` is what the run launcher resolves dependencies with.
      // Its `fetch` goes through `extractRootFromAfps` → `checkCompanionFiles`
      // — the exact call the strict rule must never reach.
      const catalog = new DbPackageCatalog({ orgId: ctx.orgId });
      const loaded = await catalog.fetch(`${SKILL_ID}@2.0.0`);
      expect(new TextDecoder().decode(loaded.files.get("SKILL.md")!)).toBe(LEGACY_SKILL_MD);
    });

    it("still serves those same bytes the write paths refuse", async () => {
      // The discriminating pair: identical content, opposite verdicts.
      expect((await createSkill(ctx, LEGACY_SKILL_MD)).status).toBe(400);
    });
  });
});
