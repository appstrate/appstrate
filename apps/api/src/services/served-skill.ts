// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP Skills extension (SEP-2640) serves for one skill: its files as
 * an Agent Skills directory, and its entry. The MCP module serves it, and the
 * chat's enforced skills (`./chat-enforced-skills.ts`) inject the same
 * `SKILL.md`. Pure: the reads and the access rule live in
 * `./served-skills.ts` and `./skill-read.ts`; the `skill://` grammar in
 * `@appstrate/core/skill-uri`.
 */

import {
  isValidSkillName,
  normalizeSkillMd,
  parseSkillFrontmatter,
  setSkillMdVersion,
  SKILL_NAME_MAX_LENGTH,
} from "@appstrate/afps-shared/companion-files";
import { parseScopedName, toSlug } from "@appstrate/core/naming";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  skillFileDigest,
  skillFileUri,
  type SkillAddress,
  type SkillEntry,
} from "@appstrate/core/skill-uri";
import { isSafeArchivePath } from "@appstrate/core/zip";
import { PACKAGE_CONTENT_ENTRY, PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";

export const SKILL_ENTRY = PACKAGE_CONTENT_ENTRY.skill!.path;

/** Appstrate packaging, not skill content: archives carry them, a skill directory does not. */
const PACKAGING_ENTRIES: ReadonlySet<string> = new Set([PACKAGE_MANIFEST_FILE, "RECORD"]);

/**
 * The served skill name: the frontmatter `name` when it is a valid Agent
 * Skills name (every platform write enforces that), else one derived from the
 * package name segment, `null` when neither yields one.
 */
export function skillName(frontmatterName: string, packageNameSegment: string): string | null {
  if (isValidSkillName(frontmatterName)) return frontmatterName;
  const fromPackage = toSlug(packageNameSegment, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
  return isValidSkillName(fromPackage) ? fromPackage : null;
}

/** A skill as served: its name, its files, and its frontmatter read from the served `SKILL.md`. */
export interface ServedSkill {
  name: string;
  frontmatter: SkillEntry["frontmatter"];
  files: Record<string, Uint8Array>;
}

type ServeSkillResult = { ok: true; skill: ServedSkill } | { ok: false; reason: string };

/**
 * The stored tree of `packageId` as an Agent Skills directory: packaging
 * entries dropped, `SKILL.md` normalized (its `name`, and its
 * `metadata.version` set to `version`, absent when `null`), within the size
 * limits of SEP-2640. A tree that cannot be served whole is refused with the reason,
 * never trimmed.
 */
export function serveSkill(
  packageId: string,
  stored: Record<string, Uint8Array>,
  version: string | null,
): ServeSkillResult {
  const files: Record<string, Uint8Array> = {};
  for (const path of Object.keys(stored).sort()) {
    if (PACKAGING_ENTRIES.has(path)) continue;
    if (!isSafeArchivePath(path)) return { ok: false, reason: `unsafe file path "${path}"` };
    files[path] = stored[path]!;
  }
  const entry = files[SKILL_ENTRY];
  if (!entry) return { ok: false, reason: `no ${SKILL_ENTRY}` };

  const authored = new TextDecoder().decode(entry);
  const name = skillName(
    parseSkillFrontmatter(authored).name,
    parseScopedName(packageId)?.name ?? "",
  );
  if (!name) return { ok: false, reason: "no valid Agent Skills name" };
  const served = setSkillMdVersion(normalizeSkillMd(authored, name), version);
  const parsed = parseSkillFrontmatter(served);
  if (parsed.name !== name || !parsed.description) {
    return { ok: false, reason: `${SKILL_ENTRY} frontmatter lacks a name or a description` };
  }
  if (served !== authored) files[SKILL_ENTRY] = new TextEncoder().encode(served);

  // The limits apply to the served bytes, normalized `SKILL.md` included.
  const sizes = Object.values(files).map((bytes) => bytes.byteLength);
  if (sizes.length > SKILL_MAX_FILES) {
    return { ok: false, reason: `more than ${SKILL_MAX_FILES} files` };
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > SKILL_MAX_TOTAL_BYTES) {
    return { ok: false, reason: `more than ${SKILL_MAX_TOTAL_BYTES} bytes` };
  }
  return {
    ok: true,
    skill: {
      name,
      // Verbatim: `parseSkillFrontmatter` read `name` and `description` as strings from these fields.
      frontmatter: parsed.fields as SkillEntry["frontmatter"],
      files,
    },
  };
}

/**
 * The `SKILL.md` {@link serveSkill} serves from `stored`, with the served name:
 * the text the chat injects and `resources/read` answers, or why the tree
 * cannot be served.
 */
export function serveSkillMd(
  packageId: string,
  stored: Record<string, Uint8Array>,
  version: string | null,
): { ok: true; name: string; content: string } | { ok: false; reason: string } {
  const served = serveSkill(packageId, stored, version);
  if (!served.ok) return served;
  return {
    ok: true,
    name: served.skill.name,
    content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(served.skill.files[SKILL_ENTRY]),
  };
}

/** The SEP-2640 entry of a served skill: `SKILL.md` URI, frontmatter, every file with its digest. */
export function skillEntry(
  address: Omit<SkillAddress, "name" | "path">,
  skill: ServedSkill,
): SkillEntry {
  const uriOf = (path: string) => skillFileUri({ ...address, name: skill.name, path });
  return {
    uri: uriOf(SKILL_ENTRY),
    frontmatter: skill.frontmatter,
    resources: Object.keys(skill.files)
      .sort()
      .map((path) => {
        const bytes = skill.files[path]!;
        return { uri: uriOf(path), digest: skillFileDigest(bytes), size: bytes.byteLength };
      }),
  };
}
