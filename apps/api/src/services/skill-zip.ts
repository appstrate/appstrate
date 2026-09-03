// SPDX-License-Identifier: Apache-2.0

import { unzipArtifact, stripWrapperPrefix, type ParsedPackageZip } from "@appstrate/core/zip";
import { decodeSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { extractSkillMeta, validateManifest } from "@appstrate/core/validation";
import { bumpPatch } from "@appstrate/core/semver";
import { getPackageById } from "./package-items/crud.ts";
import { assertContentConforms } from "./package-items/config.ts";
import { getLatestVersionInfo } from "./package-versions.ts";

type SkillOnlyResult =
  | { ok: true; parsed: ParsedPackageZip }
  | { ok: false; reason: "not_a_skill" }
  | { ok: false; reason: "unchanged" };

export async function tryParseSkillOnlyZip(
  zipBytes: Uint8Array,
  orgSlug: string,
): Promise<SkillOnlyResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipArtifact(zipBytes);
  } catch {
    return { ok: false, reason: "not_a_skill" };
  }

  // Strip single wrapper folder if present (e.g. ZIPs from macOS Finder)
  files = stripWrapperPrefix(files);

  const skillRaw = files["SKILL.md"];
  if (!skillRaw) return { ok: false, reason: "not_a_skill" };

  const skillMd = decodeSkillMarkdown(skillRaw);

  // Carrying a SKILL.md answered the `not_a_skill` question, so a bad
  // frontmatter is reported as itself. The only gate on this path: the manifest
  // below is SYNTHESISED, so `parsePackageZip` never sees this archive.
  assertContentConforms("skill", skillMd, "file");

  const meta = extractSkillMeta(skillMd);
  const packageId = `@${orgSlug}/${meta.name}`;
  const existing = await getPackageById(packageId);

  let version = "1.0.0";
  if (existing) {
    if (existing.draftContent === skillMd) {
      return { ok: false, reason: "unchanged" };
    }
    const latestVer = await getLatestVersionInfo(packageId);
    const latestStr = latestVer?.version;
    if (latestStr) {
      version = bumpPatch(latestStr) ?? version;
    }
  }

  const validation = validateManifest({
    name: packageId,
    version,
    type: "skill" as const,
    schema_version: "0.1",
    description: meta.description || undefined,
    display_name: meta.name,
  });
  if (!validation.valid) return { ok: false, reason: "not_a_skill" };

  const validatedManifest = validation.manifest!;
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(validatedManifest, null, 2));

  return {
    ok: true,
    parsed: {
      manifest: validatedManifest,
      content: skillMd,
      files,
      type: "skill",
      packageId,
      // The manifest is synthesised here from SKILL.md frontmatter, and only
      // agents carry `runtime_tools` — nothing can have been dropped.
      droppedRuntimeTools: [],
    },
  };
}
