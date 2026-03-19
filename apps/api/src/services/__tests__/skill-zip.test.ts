import { describe, test, expect, mock, beforeEach } from "bun:test";
import { zipArtifact } from "@appstrate/core/zip";

/**
 * Tests for tryParseSkillOnlyZip — manifest-less skill ZIP recovery.
 *
 * Mocks: package-items (getPackageById), package-versions (getLatestVersionWithManifest).
 */

// --- Configurable mock state ---

let mockPackageById: Record<string, { draftContent: string; orgId: string; type: string } | null> =
  {};
let mockLatestVersion: Record<string, { id: number; manifest: Record<string, unknown> } | null> =
  {};

// --- Mocks (must be before dynamic import) ---

mock.module("../package-items/index.ts", () => ({
  getPackageById: async (id: string) => mockPackageById[id] ?? null,
}));

mock.module("../package-versions.ts", () => ({
  getLatestVersionWithManifest: async (packageId: string) => mockLatestVersion[packageId] ?? null,
}));

// --- Dynamic import (after mocks) ---

const { tryParseSkillOnlyZip } = await import("../skill-zip.ts");

// --- Helpers ---

function buildSkillMd(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function buildSkillZip(skillMd: string, extraFiles?: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "SKILL.md": new TextEncoder().encode(skillMd),
  };
  if (extraFiles) {
    for (const [path, content] of Object.entries(extraFiles)) {
      entries[path] = new TextEncoder().encode(content);
    }
  }
  return zipArtifact(entries, 6);
}

function buildEmptyZip(): Uint8Array {
  return zipArtifact({ "readme.txt": new TextEncoder().encode("hello") }, 6);
}

// --- Reset ---

beforeEach(() => {
  mockPackageById = {};
  mockLatestVersion = {};
});

// --- Tests ---

describe("tryParseSkillOnlyZip", () => {
  test("new skill ZIP → ok with version 1.0.0", async () => {
    const skillMd = buildSkillMd("my-skill", "A test skill");
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.parsed.manifest as Record<string, unknown>;
    expect(result.parsed.type).toBe("skill");
    expect(result.parsed.content).toBe(skillMd);
    expect(m.name).toBe("@acme/my-skill");
    expect(m.version).toBe("1.0.0");
    expect(m.type).toBe("skill");
    expect(m.schemaVersion).toBe("1.0");
    expect(m.displayName).toBe("my-skill");
    expect(m.description).toBe("A test skill");
  });

  test("manifest.json is injected into files", async () => {
    const skillMd = buildSkillMd("my-skill", "A test skill");
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.files["manifest.json"]).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(result.parsed.files["manifest.json"]));
    expect(manifest.name).toBe("@acme/my-skill");
    expect(manifest.version).toBe("1.0.0");
  });

  test("SKILL.md preserved in files", async () => {
    const skillMd = buildSkillMd("my-skill", "A test skill");
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.parsed.files["SKILL.md"])).toBe(skillMd);
  });

  test("extra files in ZIP are preserved", async () => {
    const skillMd = buildSkillMd("my-skill", "A test skill");
    const zip = buildSkillZip(skillMd, { "notes.txt": "some notes" });

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.parsed.files["notes.txt"])).toBe("some notes");
  });

  test("ZIP without SKILL.md → not_a_skill", async () => {
    const zip = buildEmptyZip();

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_skill");
  });

  test("invalid ZIP bytes → not_a_skill", async () => {
    const result = await tryParseSkillOnlyZip(new Uint8Array([1, 2, 3, 4]), "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_skill");
  });

  test("SKILL.md without frontmatter → not_a_skill", async () => {
    const zip = buildSkillZip("# Just a markdown file without frontmatter");

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_skill");
  });

  test("SKILL.md with empty name → not_a_skill", async () => {
    const zip = buildSkillZip("---\ndescription: no name field\n---\n");

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_skill");
  });

  test("existing skill with same content → unchanged", async () => {
    const skillMd = buildSkillMd("my-skill", "A test skill");
    const zip = buildSkillZip(skillMd);

    mockPackageById["@acme/my-skill"] = {
      draftContent: skillMd,
      orgId: "org-1",
      type: "skill",
    };

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unchanged");
  });

  test("existing skill with different content → auto-bump version", async () => {
    const oldSkillMd = buildSkillMd("my-skill", "Old description");
    const newSkillMd = buildSkillMd("my-skill", "New description");
    const zip = buildSkillZip(newSkillMd);

    mockPackageById["@acme/my-skill"] = {
      draftContent: oldSkillMd,
      orgId: "org-1",
      type: "skill",
    };
    mockLatestVersion["@acme/my-skill"] = {
      id: 1,
      manifest: { name: "@acme/my-skill", version: "1.2.3", type: "skill" },
    };

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.parsed.manifest as Record<string, unknown>;
    expect(m.version).toBe("1.2.4");
    expect(m.description).toBe("New description");
  });

  test("existing skill with no published version → fallback to 1.0.0", async () => {
    const oldSkillMd = buildSkillMd("my-skill", "Old description");
    const newSkillMd = buildSkillMd("my-skill", "New description");
    const zip = buildSkillZip(newSkillMd);

    mockPackageById["@acme/my-skill"] = {
      draftContent: oldSkillMd,
      orgId: "org-1",
      type: "skill",
    };

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.parsed.manifest as Record<string, unknown>).version).toBe("1.0.0");
  });

  test("existing skill with version manifest missing version field → fallback to 1.0.0", async () => {
    const oldSkillMd = buildSkillMd("my-skill", "Old");
    const newSkillMd = buildSkillMd("my-skill", "New");
    const zip = buildSkillZip(newSkillMd);

    mockPackageById["@acme/my-skill"] = {
      draftContent: oldSkillMd,
      orgId: "org-1",
      type: "skill",
    };
    mockLatestVersion["@acme/my-skill"] = {
      id: 1,
      manifest: { name: "@acme/my-skill", type: "skill" },
    };

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.parsed.manifest as Record<string, unknown>).version).toBe("1.0.0");
  });

  test("description and displayName from frontmatter are propagated", async () => {
    const skillMd = buildSkillMd("analyzer", "Analyzes all the things");
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "myorg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.parsed.manifest as Record<string, unknown>;
    expect(m.description).toBe("Analyzes all the things");
    expect(m.displayName).toBe("analyzer");
    expect(m.name).toBe("@myorg/analyzer");
  });

  test("orgSlug is correctly used in packageId", async () => {
    const skillMd = buildSkillMd("test-skill", "Test");
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "my-company");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.parsed.manifest as Record<string, unknown>).name).toBe("@my-company/test-skill");
  });

  test("skill with body content after frontmatter", async () => {
    const skillMd = buildSkillMd(
      "detailed-skill",
      "A skill with body",
      "\n## Instructions\n\nDo the thing.\n",
    );
    const zip = buildSkillZip(skillMd);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.content).toBe(skillMd);
    expect(result.parsed.content).toContain("## Instructions");
  });

  // --- Nested folder handling ---

  test("SKILL.md inside a single wrapper folder → rebased to root", async () => {
    const skillMd = buildSkillMd("nested-skill", "A nested skill");
    const entries: Record<string, Uint8Array> = {
      "my-skill/SKILL.md": new TextEncoder().encode(skillMd),
      "my-skill/extra.txt": new TextEncoder().encode("extra data"),
    };
    const zip = zipArtifact(entries, 6);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.parsed.manifest as Record<string, unknown>;
    expect(m.name).toBe("@acme/nested-skill");
    expect(result.parsed.content).toBe(skillMd);
    // Files should be rebased — no prefix
    expect(result.parsed.files["SKILL.md"]).toBeDefined();
    expect(result.parsed.files["extra.txt"]).toBeDefined();
    expect(result.parsed.files["my-skill/SKILL.md"]).toBeUndefined();
  });

  test("nested folder: manifest.json injected at rebased root", async () => {
    const skillMd = buildSkillMd("nested-skill", "desc");
    const entries: Record<string, Uint8Array> = {
      "folder/SKILL.md": new TextEncoder().encode(skillMd),
    };
    const zip = zipArtifact(entries, 6);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.files["manifest.json"]).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(result.parsed.files["manifest.json"]));
    expect(manifest.name).toBe("@acme/nested-skill");
  });

  test("files outside the wrapper folder are excluded after rebase", async () => {
    const skillMd = buildSkillMd("my-skill", "desc");
    const entries: Record<string, Uint8Array> = {
      "wrapper/SKILL.md": new TextEncoder().encode(skillMd),
      "wrapper/included.txt": new TextEncoder().encode("yes"),
      "stray-file.txt": new TextEncoder().encode("outside wrapper"),
    };
    const zip = zipArtifact(entries, 6);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.files["SKILL.md"]).toBeDefined();
    expect(result.parsed.files["included.txt"]).toBeDefined();
    expect(result.parsed.files["stray-file.txt"]).toBeUndefined();
  });

  test("SKILL.md nested two levels deep → not_a_skill", async () => {
    const skillMd = buildSkillMd("deep-skill", "too deep");
    const entries: Record<string, Uint8Array> = {
      "a/b/SKILL.md": new TextEncoder().encode(skillMd),
    };
    const zip = zipArtifact(entries, 6);

    const result = await tryParseSkillOnlyZip(zip, "acme");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_skill");
  });
});
