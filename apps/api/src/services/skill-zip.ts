// SPDX-License-Identifier: Apache-2.0

import { unzipArtifact, stripWrapperPrefix, type ParsedPackageZip } from "@appstrate/core/zip";
import { extractSkillMeta, validateManifest } from "@appstrate/core/validation";
import { bumpPatch } from "@appstrate/core/semver";
import { getPackageById } from "./package-items/index.ts";
import { getLatestVersionWithManifest } from "./package-versions.ts";

export type SkillOnlyResult =
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

  const skillMd = new TextDecoder().decode(skillRaw);
  const meta = extractSkillMeta(skillMd);
  if (!meta.name) return { ok: false, reason: "not_a_skill" };

  const packageId = `@${orgSlug}/${meta.name}`;
  const existing = await getPackageById(packageId);

  let version = "1.0.0";
  if (existing) {
    if (existing.draftContent === skillMd) {
      return { ok: false, reason: "unchanged" };
    }
    const latestVer = await getLatestVersionWithManifest(packageId);
    const latestStr = latestVer?.manifest?.version as string | undefined;
    if (latestStr) {
      version = bumpPatch(latestStr) ?? version;
    }
  }

  const validation = validateManifest({
    name: packageId,
    version,
    type: "skill" as const,
    schemaVersion: "1.0",
    description: meta.description || undefined,
    displayName: meta.name,
  });
  if (!validation.valid) return { ok: false, reason: "not_a_skill" };

  const validatedManifest = validation.manifest!;
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(validatedManifest, null, 2));

  return {
    ok: true,
    parsed: { manifest: validatedManifest, content: skillMd, files, type: "skill" },
  };
}
