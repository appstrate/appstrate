// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP Skills extension (SEP-2640) serves for one skill: its `skill://`
 * URIs, its files as an Agent Skills directory, and its entry. Pure: the reads
 * and the access rule live in `./skills.ts` and `services/skill-read.ts`.
 *
 * URI forms (the authority is the space id, `<scope>` drops the `@`):
 * - published: `skill://<spaceId>/<scope>/<package-name>/<name>/<path>`
 * - draft:     `skill://<spaceId>/<scope>/<package-name>@draft/<name>/<path>`
 *
 * `<name>` is the served frontmatter `name`, so the segment before `SKILL.md`
 * equals it, as the extension requires. The draft marker rides on the package
 * segment, so both forms have the same depth and a file path never reads as a
 * definition marker.
 */

import { createHash } from "node:crypto";
import {
  isValidSkillName,
  normalizeSkillMd,
  parseSkillFrontmatter,
  SKILL_NAME_MAX_LENGTH,
} from "@appstrate/afps-shared/companion-files";
import type { SkillEntry } from "@appstrate/mcp-transport";
import { parseScopedName, toSlug } from "@appstrate/core/naming";
import { isSafeArchivePath } from "@appstrate/core/zip";
import {
  PACKAGE_CONTENT_ENTRY,
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
} from "@appstrate/core/package-files";

export const SKILL_URI_PREFIX = "skill://";
export const SKILL_ENTRY = PACKAGE_CONTENT_ENTRY.skill!.path;
const DRAFT_MARKER = "@draft";

/** SEP-2640: a server SHOULD NOT serve a skill with more files or bytes than this. */
export const SKILL_MAX_FILES = 512;
const SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/**
 * The largest file a `skill://` read returns: the largest file a package draft
 * write accepts, so every authored file is servable.
 */
export const SKILL_FILE_MAX_BYTES = PACKAGE_FILE_INLINE_MAX_BYTES;

/** Appstrate packaging, not skill content: archives carry them, a skill directory does not. */
const PACKAGING_ENTRIES: ReadonlySet<string> = new Set([PACKAGE_MANIFEST_FILE, "RECORD"]);

export type SkillDefinition = "published" | "draft";

export interface SkillAddress {
  spaceId: string;
  packageId: string;
  definition: SkillDefinition;
  /** The served skill name. */
  name: string;
  /** A file path inside the skill directory. */
  path: string;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function skillFileUri(address: SkillAddress): string {
  const scoped = parseScopedName(address.packageId);
  if (!scoped) throw new Error(`Not a scoped package id: ${address.packageId}`);
  const marker = address.definition === "draft" ? DRAFT_MARKER : "";
  return (
    `${SKILL_URI_PREFIX}${address.spaceId}/${scoped.scope.replace(/^@/, "")}/` +
    `${scoped.name}${marker}/${address.name}/${encodePath(address.path)}`
  );
}

/** The address a `skill://` URI names, `null` when it is not one of the two forms. */
export function parseSkillUri(uri: string): SkillAddress | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null;
  const segments = uri.slice(SKILL_URI_PREFIX.length).split("/");
  if (segments.length < 5 || segments.some((segment) => segment === "")) return null;
  const [spaceId, scope, packageSegment, name, ...rest] = segments as [
    string,
    string,
    string,
    string,
    ...string[],
  ];
  const draft = packageSegment.endsWith(DRAFT_MARKER);
  const packageName = draft ? packageSegment.slice(0, -DRAFT_MARKER.length) : packageSegment;
  const packageId = `@${scope}/${packageName}`;
  if (!parseScopedName(packageId) || !isValidSkillName(name)) return null;
  let path: string;
  try {
    path = rest.map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  if (!isSafeArchivePath(path)) return null;
  return { spaceId, packageId, definition: draft ? "draft" : "published", name, path };
}

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
 * entries dropped, `SKILL.md` normalized, within the size limits above. A tree
 * that cannot be served whole is refused with the reason, never trimmed.
 */
export function serveSkill(
  packageId: string,
  stored: Record<string, Uint8Array>,
): ServeSkillResult {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const path of Object.keys(stored).sort()) {
    if (PACKAGING_ENTRIES.has(path)) continue;
    if (!isSafeArchivePath(path)) return { ok: false, reason: `unsafe file path "${path}"` };
    const bytes = stored[path]!;
    if (bytes.byteLength > SKILL_FILE_MAX_BYTES) {
      return { ok: false, reason: `"${path}" exceeds ${SKILL_FILE_MAX_BYTES} bytes` };
    }
    total += bytes.byteLength;
    files[path] = bytes;
  }
  const count = Object.keys(files).length;
  if (count > SKILL_MAX_FILES) return { ok: false, reason: `more than ${SKILL_MAX_FILES} files` };
  if (total > SKILL_MAX_TOTAL_BYTES) {
    return { ok: false, reason: `more than ${SKILL_MAX_TOTAL_BYTES} bytes` };
  }
  const entry = files[SKILL_ENTRY];
  if (!entry) return { ok: false, reason: `no ${SKILL_ENTRY}` };

  const authored = new TextDecoder().decode(entry);
  const name = skillName(
    parseSkillFrontmatter(authored).name,
    parseScopedName(packageId)?.name ?? "",
  );
  if (!name) return { ok: false, reason: "no valid Agent Skills name" };
  const served = normalizeSkillMd(authored, name);
  const parsed = parseSkillFrontmatter(served);
  if (parsed.name !== name || !parsed.description) {
    return { ok: false, reason: `${SKILL_ENTRY} frontmatter lacks a name or a description` };
  }
  if (served !== authored) files[SKILL_ENTRY] = new TextEncoder().encode(served);
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
