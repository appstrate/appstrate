// SPDX-License-Identifier: Apache-2.0

import { unzipArtifact, stripWrapperPrefix, type ParsedPackageZip } from "@appstrate/core/zip";
import {
  checkSkillMarkdown,
  decodeSkillMarkdown,
  type CompanionFileViolation,
} from "@appstrate/afps-shared/companion-files";
import { extractSkillMeta, validateManifest } from "@appstrate/core/validation";
import { bumpPatch } from "@appstrate/core/semver";
import { getPackageById } from "./package-items/crud.ts";
import { getLatestVersionInfo } from "./package-versions.ts";

type SkillOnlyResult =
  | { ok: true; parsed: ParsedPackageZip }
  | { ok: false; reason: "not_a_skill" }
  | { ok: false; reason: "unchanged" }
  /**
   * The archive IS a bare skill — it has a SKILL.md — but that SKILL.md
   * violates §3.3. Distinguished from `not_a_skill` so the caller answers with
   * the violation instead of the generic "manifest.json not found": the
   * archive the operator uploaded is one edit away from valid, and telling
   * them the manifest is missing points at a file this path synthesises.
   */
  | { ok: false; reason: "invalid_skill"; violation: CompanionFileViolation };

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

  // BOM-preserving on purpose — see `decodeSkillMarkdown`.
  const skillMd = decodeSkillMarkdown(skillRaw);

  // §3.3 FIRST. The archive already declared itself a skill by carrying a
  // SKILL.md — `not_a_skill` is reserved for the shape question above, so that
  // "your frontmatter has no name" reaches the operator as itself instead of
  // as the generic "manifest.json not found" this fallback exists to replace.
  // This is also the only §3.3 gate on the bare-ZIP path: the manifest below is
  // SYNTHESISED, so `parsePackageZip` never sees this archive.
  const violation = checkSkillMarkdown(skillMd);
  if (violation) return { ok: false, reason: "invalid_skill", violation };

  // Guaranteed non-empty and rule-conforming by the check above.
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
