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
 *   - returns `invalid_skill` (NOT `not_a_skill`) for a SKILL.md that is
 *     present but violates §3.3 — the archive already declared itself a skill
 *   - returns `unchanged` when the new SKILL.md matches `existing.draftContent`
 *   - bumps the patch version of the latest known release on a content change
 *   - the strip-wrapper-prefix path is exercised (macOS-style ZIP wrappers)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { tryParseSkillOnlyZip } from "../../../src/services/skill-zip.ts";
import { createPackageVersion } from "../../../src/services/package-versions.ts";

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

  // `not_a_skill` answers the SHAPE question — is this even a skill archive.
  // A ZIP that carries a SKILL.md has answered it, so a bad frontmatter is
  // `invalid_skill` carrying the reason. Reported as `not_a_skill` it reached
  // the operator as "manifest.json not found", naming a file this path
  // synthesises and never asked them for.
  it("returns invalid_skill when SKILL.md frontmatter is missing the name field", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-noname" });
    const buf = zipFiles({
      "SKILL.md": enc("---\ndescription: missing name.\n---\nBody."),
    });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_skill");
      if (result.reason === "invalid_skill") {
        expect(result.violation.reason).toBe("SKILL_MISSING_FRONTMATTER_NAME");
      }
    }
  });

  it("returns invalid_skill when SKILL.md declares no description", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-nodesc" });
    const buf = zipFiles({ "SKILL.md": enc("---\nname: my-skill\n---\nBody.") });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid_skill") {
      expect(result.violation.reason).toBe("SKILL_MISSING_FRONTMATTER_DESCRIPTION");
    }
  });

  // The synthesised manifest takes `description` from the frontmatter. A
  // regex reading the rest of the line made a block scalar's value the literal
  // `"|"` — a manifest description of one pipe character, and a skill that
  // passed a non-empty check while telling the agent nothing.
  it("synthesises the real text of a block-scalar description", async () => {
    const ctx = await createTestContext({ orgSlug: "skill-block" });
    const buf = zipFiles({
      "SKILL.md": enc(
        "---\nname: my-skill\ndescription: |\n  Counts words in a text.\n---\n\nBody.",
      ),
    });
    const result = await tryParseSkillOnlyZip(buf, ctx.org.slug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.manifest.description).toBe("Counts words in a text.");
    }
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
    await createPackageVersion({
      packageId,
      version: "1.2.3",
      integrity: "sha256-old",
      artifactSize: 1,
      manifest: { name: packageId, type: "skill", version: "1.2.3" },
      createdBy: ctx.user.id,
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
