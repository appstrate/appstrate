// SPDX-License-Identifier: Apache-2.0

/**
 * The `skill://` URIs and entries of the MCP Skills extension (SEP-2640) as
 * Appstrate serves them: one grammar for the server that mints them, the MCP
 * transport that carries the entries and `appstrate code sync` that reads them.
 *
 * URI forms (the authority is the space id, `<scope>` drops the `@`):
 * - published: `skill://<spaceId>/<scope>/<package-name>/<name>/<path>`
 * - draft:     `skill://<spaceId>/<scope>/<package-name>@draft/<name>/<path>`
 *
 * `<name>` is the served frontmatter `name`, so the segment before `SKILL.md`
 * equals it, as the extension requires. The draft marker rides on the package
 * segment, so both forms have the same depth and a file path never reads as a
 * definition marker. Each path segment is percent-encoded with
 * `encodeURIComponent`; only that canonical spelling parses.
 */

import { isValidSkillName } from "@appstrate/afps-shared/companion-files";
import { parseScopedName } from "./naming.ts";
import { isSafeArchivePath } from "./zip.ts";

export const SKILL_URI_PREFIX = "skill://";
const DRAFT_MARKER = "@draft";

/** A file of a skill: its resource URI, `sha256:{hex}` digest of its raw bytes, and byte length. */
export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

/** A SEP-2640 skill entry, identical in `skills/list` and `skills/get`. */
export interface SkillEntry {
  /** Resource URI of the skill's `SKILL.md`, readable via `resources/read`. */
  uri: string;
  /** The `SKILL.md` YAML frontmatter, verbatim. */
  frontmatter: { name: string; description: string; [key: string]: unknown };
  /** Every file of the skill, `SKILL.md` included. */
  resources: SkillResource[];
}

/** What a `skill://` URI names. */
export interface SkillAddress {
  spaceId: string;
  packageId: string;
  definition: "published" | "draft";
  /** The served skill name, a valid Agent Skills name. */
  name: string;
  /** A file path inside the skill directory, one `isSafeArchivePath` accepts. */
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
    `${SKILL_URI_PREFIX}${address.spaceId}/${scoped.scope}/` +
    `${scoped.name}${marker}/${address.name}/${encodePath(address.path)}`
  );
}

/**
 * The address a `skill://` URI names, `null` unless it is the canonical
 * spelling of one of the two forms: a scoped package, a valid skill name and a
 * file path that stays inside the skill directory.
 */
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
  let address: SkillAddress;
  try {
    address = {
      spaceId,
      packageId,
      definition: draft ? "draft" : "published",
      name,
      path: rest.map(decodeURIComponent).join("/"),
    };
  } catch {
    return null;
  }
  if (!isSafeArchivePath(address.path)) return null;
  // `%2F` inside a segment, or any other non-canonical escape, names a
  // different path than the one the server mints.
  return skillFileUri(address) === uri ? address : null;
}
