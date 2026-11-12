// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP Skills extension (SEP-2640) serves for one skill: its files as
 * an Agent Skills directory, and its entry. Pure: the reads and the access rule
 * live in `./skills.ts` and `services/skill-read.ts`; the `skill://` grammar in
 * `@appstrate/core/skill-uri`.
 */

import { createHash } from "node:crypto";
import {
  isValidSkillName,
  normalizeSkillMd,
  parseSkillFrontmatter,
  setSkillMdVersion,
  SKILL_NAME_MAX_LENGTH,
} from "@appstrate/afps-shared/companion-files";
import { parseScopedName, toSlug } from "@appstrate/core/naming";
import { skillFileUri, type SkillAddress, type SkillEntry } from "@appstrate/core/skill-uri";
import { isSafeArchivePath } from "@appstrate/core/zip";
import { PACKAGE_CONTENT_ENTRY, PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";

export const SKILL_ENTRY = PACKAGE_CONTENT_ENTRY.skill!.path;

/** SEP-2640: a server SHOULD NOT serve a skill with more files or bytes than this. */
export const SKILL_MAX_FILES = 512;
const SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

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

export type ServeSkillResult = { ok: true; skill: ServedSkill } | { ok: false; reason: string };

/**
 * The stored tree of `packageId` as an Agent Skills directory: packaging
 * entries dropped, `SKILL.md` normalized (its `name`, and its
 * `metadata.version` set to `version`, absent when `null`), within the size
 * limits above. A tree that cannot be served whole is refused with the reason,
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

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
        return { uri: uriOf(path), digest: sha256Digest(bytes), size: bytes.byteLength };
      }),
  };
}
