import { unzipArtifact, type ParsedPackageZip } from "@appstrate/core/zip";
import { extractSkillMeta, validateManifest } from "@appstrate/core/validation";
import { bumpPatch } from "@appstrate/core/semver";
import { getPackageById } from "./package-items.ts";
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

  // Find SKILL.md — may be at root or inside a single wrapper folder
  let skillRaw = files["SKILL.md"];
  if (!skillRaw) {
    // Look for prefix/SKILL.md (one level deep) and re-base all files
    const skillEntry = Object.keys(files).find(
      (k) => k.endsWith("/SKILL.md") && !k.includes("/", k.indexOf("/") + 1),
    );
    if (!skillEntry) return { ok: false, reason: "not_a_skill" };

    const prefix = skillEntry.slice(0, skillEntry.indexOf("/") + 1);
    const rebased: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files)) {
      if (path.startsWith(prefix)) {
        rebased[path.slice(prefix.length)] = data;
      }
    }
    files = rebased;
    skillRaw = files["SKILL.md"];
  }
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
