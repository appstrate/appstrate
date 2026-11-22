// SPDX-License-Identifier: Apache-2.0

/**
 * The `skill://` URIs and entries of the MCP Skills extension (SEP-2640) as
 * Appstrate serves them: one grammar for the server that mints them, the MCP
 * transport that carries the entries and `appstrate code sync` that reads them.
 *
 * The URI grammar lives in `@appstrate/core/skill-address`, which imports
 * nothing server-only so a browser bundle can read it; this module re-exports
 * it and adds the size limits, the `_meta` keys, the entry types and the
 * `node:crypto` digest.
 */

import { createHash } from "node:crypto";

export {
  SKILL_URI_PREFIX,
  parseSkillUri,
  parseSkillUriPackage,
  skillFileUri,
  type SkillAddress,
} from "./skill-address.ts";

/** SEP-2640: a server SHOULD NOT serve a skill with more files than this. */
export const SKILL_MAX_FILES = 512;
/** SEP-2640: a server SHOULD NOT serve a skill with more bytes than this, all files together. */
export const SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** The SEP-2640 `digest` of a served file: `sha256:<hex>` of its bytes, a string as its UTF-8 bytes. */
export function skillFileDigest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A file of a skill: its resource URI, `sha256:{hex}` digest of its raw bytes, and byte length. */
export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

/**
 * `skills/list` request `_meta` key: `"draft"` lists the drafts the caller may
 * read, at their `@draft` URIs; absent, the list holds the published skills.
 */
export const SKILL_DEFINITION_META_KEY = "dev.appstrate/definition";

/** Entry `_meta` key of a draft: the `lock_version` of the draft its files and digests were read from. */
export const SKILL_LOCK_VERSION_META_KEY = "dev.appstrate/lock_version";

/** A SEP-2640 skill entry, identical in `skills/list` and `skills/get`. */
export interface SkillEntry {
  /** Resource URI of the skill's `SKILL.md`, readable via `resources/read`. */
  uri: string;
  /** The `SKILL.md` YAML frontmatter, verbatim. */
  frontmatter: { name: string; description: string; [key: string]: unknown };
  /** Every file of the skill, `SKILL.md` included. */
  resources: SkillResource[];
  /** Appstrate fields: a draft's entry carries {@link SKILL_LOCK_VERSION_META_KEY}. */
  _meta?: { [SKILL_LOCK_VERSION_META_KEY]?: number };
}
