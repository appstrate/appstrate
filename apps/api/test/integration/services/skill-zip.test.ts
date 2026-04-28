// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `services/skill-zip.tryParseSkillOnlyZip`.
 *
 * Path-traversal sanitization, ZIP parsing, and manifest validation are
 * owned by `@appstrate/core/zip` and `@appstrate/core/validation` (tested
 * in `packages/core/test/zip.test.ts`). This suite covers the dispatch
 * logic specific to skill packages:
 *
 *   - returns `not_a_skill` for non-ZIP bytes
 *   - returns `not_a_skill` for a ZIP missing SKILL.md
 *   - returns `not_a_skill` for SKILL.md missing required frontmatter
 *   - returns `unchanged` when the new SKILL.md matches `existing.draftContent`
 *   - bumps the patch version of the latest known release on a content change
 *   - the strip-wrapper-prefix path is exercised (macOS-style ZIP wrappers)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { tryParseSkillOnlyZip } from "../../../src/services/skill-zip.ts";

const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  const entries = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, [v, { mtime: DOS_EPOCH_MS, level: 0 }] as const]),
  );
  return zipSync(
    entries as unknown as Parameters<typeof zipSync>[0],
    { level: 0, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}

const VALID_SKILL_MD = "---\nname: my-skill\ndescription: A test skill.\n---\n\nSkill body.";

describe("tryParseSkillOnlyZip", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns not_a_skill on non-ZIP bytes (junk input)", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-junk" });
    const result = await tryParseSkillOnlyZip(enc("not a zip at all"), ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_a_skill");
  });

  it("returns not_a_skill when the ZIP has no SKILL.md", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-missing" });
    const buf = zipFiles({ "README.md": enc("hello") });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_a_skill");
  });

  it("returns not_a_skill when SKILL.md frontmatter is missing the name field", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-noname" });
    const buf = zipFiles({
      "SKILL.md": enc("---\ndescription: missing name.\n---\nBody."),
    });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_a_skill");
  });

  it("parses a fresh skill ZIP into a ParsedPackageZip", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-fresh" });
    const buf = zipFiles({ "SKILL.md": enc(VALID_SKILL_MD) });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.type).toBe("skill");
      expect(result.parsed.manifest.name).toBe(`@${ctx.org.slug}/my-skill`);
      expect(result.parsed.manifest.version).toBe("1.0.0");
      expect(result.parsed.content).toBe(VALID_SKILL_MD);
      // The reconstructed manifest.json is injected into the files map.
      expect(result.parsed.files["manifest.json"]).toBeDefined();
    }
  });

  it("strips a single wrapper directory (macOS Finder-style ZIP)", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-wrap" });
    const buf = zipFiles({ "wrapped/SKILL.md": enc(VALID_SKILL_MD) });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.manifest.name).toBe(`@${ctx.org.slug}/my-skill`);
    }
  });

  it("returns unchanged when SKILL.md matches the existing draftContent", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-same" });
    const packageId = `@${ctx.org.slug}/my-skill`;
    await db.insert(packages).values({
      id: packageId,
      orgId: ctx.orgId,
      type: "skill",
      source: "local",
      draftManifest: { name: packageId, type: "skill", version: "1.0.0" },
      draftContent: VALID_SKILL_MD,
      createdBy: ctx.user.id,
    });

    const buf = zipFiles({ "SKILL.md": enc(VALID_SKILL_MD) });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unchanged");
  });

  it("bumps the patch when the latest published version is known and content changed", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-bump" });
    const packageId = `@${ctx.org.slug}/my-skill`;
    await db.insert(packages).values({
      id: packageId,
      orgId: ctx.orgId,
      type: "skill",
      source: "local",
      draftManifest: { name: packageId, type: "skill", version: "1.2.3" },
      draftContent: "old body",
      createdBy: ctx.user.id,
    });
    await db.insert(packageVersions).values({
      packageId,
      version: "1.2.3",
      integrity: "sha256-old",
      artifactSize: 1,
      manifest: { name: packageId, type: "skill", version: "1.2.3" },
    });

    const buf = zipFiles({ "SKILL.md": enc(VALID_SKILL_MD) });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.manifest.version).toBe("1.2.4");
    }

    // Sanity: the seeded row was not mutated by the parser.
    const [row] = await db.select().from(packages).where(eq(packages.id, packageId));
    expect(row!.draftContent).toBe("old body");
  });
});
