// SPDX-License-Identifier: Apache-2.0

/**
 * The grammar of Appstrate's `skill://` URIs (MCP Skills extension, SEP-2640),
 * free of any server-only import so the browser can parse them too (the chat
 * UI reads them). The entries, limits and digest the server and the CLI also
 * need live in `@appstrate/core/skill-uri`.
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
 * The package a `skill://` URI names and whether it names its draft, read from
 * its first three segments alone; `null` when they name no scoped package.
 */
export function parseSkillUriPackage(
  uri: string,
): { packageId: string; definition: SkillAddress["definition"] } | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null;
  const [, scope, packageSegment] = uri.slice(SKILL_URI_PREFIX.length).split("/");
  if (!scope || !packageSegment) return null;
  const draft = packageSegment.endsWith(DRAFT_MARKER);
  const packageId = `@${scope}/${draft ? packageSegment.slice(0, -DRAFT_MARKER.length) : packageSegment}`;
  return parseScopedName(packageId)
    ? { packageId, definition: draft ? "draft" : "published" }
    : null;
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
  const [spaceId, , , name, ...rest] = segments as [string, string, string, string, ...string[]];
  const pkg = parseSkillUriPackage(uri);
  if (!pkg || !isValidSkillName(name)) return null;
  let address: SkillAddress;
  try {
    address = {
      spaceId,
      packageId: pkg.packageId,
      definition: pkg.definition,
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
