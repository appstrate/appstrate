// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate skill artifact → Agent Skills directory: the pure half of
 * `appstrate skills sync`. No network, no filesystem.
 *
 * The output is a function of the input — sorted keys, no timestamps, no sync
 * metadata — because a `mode: "copy"` plugin's version IS the hash of its
 * contents, so a byte-identical re-run must hash identically.
 */

import { isValidSkillName, SKILL_NAME_MAX_LENGTH } from "@appstrate/afps-shared/companion-files";
import { extractSkillMeta } from "@appstrate/core/validation";
import { toSlug } from "@appstrate/core/naming";

/**
 * ZIP entries that are Appstrate packaging, not skill content.
 *
 * Exported because the draft path in `./plan.ts` must know the same set BEFORE
 * fetching: there, each file is a separate rate-limited request, so "drop it
 * after downloading it" is two wasted round-trips per skill.
 */
export const DROPPED_ENTRIES: ReadonlySet<string> = new Set(["manifest.json", "RECORD"]);

/**
 * The one file an Agent Skills directory must contain. Exported because
 * `commands/skills.ts` tests for it rather than for the directory: a directory
 * can survive its `SKILL.md`.
 */
export const SKILL_ENTRY = "SKILL.md";

export class SkillMaterializeError extends Error {
  constructor(
    public readonly code: "unsafe_entry" | "empty_artifact" | "unslugifiable_name",
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillMaterializeError";
  }
}

/**
 * Derive the Agent Skills slug for a package.
 *
 * The frontmatter `name` wins when it is already legal — that is what the
 * author typed, what Appstrate shows, and what the platform now enforces on
 * every write. Legacy artifacts predating that rule fall back to the package's
 * `name` segment, which is slug-shaped by construction.
 */
export function skillSlug(frontmatterName: string, packageNameSegment: string): string {
  if (isValidSkillName(frontmatterName)) return frontmatterName;
  const fromPackage = toSlug(packageNameSegment, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
  if (isValidSkillName(fromPackage)) return fromPackage;
  throw new SkillMaterializeError(
    "unslugifiable_name",
    `Cannot derive a skill directory name from "${frontmatterName}" or "${packageNameSegment}"`,
    "Agent Skills names are 1-64 characters of [a-z0-9-]. Rename the skill in Appstrate.",
  );
}

/**
 * The deterministic collision fallback: `<scope>-<name>` for the package id,
 * then `-2`, `-3`, … until free. Applied to the *later* of two skills that
 * claim the same slug, ordered by package id, so which one keeps the short
 * name never depends on server ordering.
 *
 * The numeric tail is not decoration: `@a/b` named "acme-foo", `@acme/bar` and
 * `@acme/foo` all reduce to `acme-foo`, and returning a duplicate would hand
 * two skills the same directory and abort the whole sync on the `wx` write.
 */
export function collisionSlug(packageId: string, taken: ReadonlySet<string>): string {
  const withoutAt = packageId.replace(/^@/, "").replace("/", "-");
  const base = toSlug(withoutAt, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
  if (!isValidSkillName(base)) {
    throw new SkillMaterializeError(
      "unslugifiable_name",
      `Cannot derive a collision-free skill directory name from "${packageId}"`,
      "Agent Skills names are 1-64 characters of [a-z0-9-].",
    );
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    // Trim the BASE, not the suffix: a truncated counter would collide again.
    const head = base.slice(0, SKILL_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate) && isValidSkillName(candidate)) return candidate;
  }
}

/**
 * Reject an archive entry path that must never reach the filesystem.
 *
 * `unzipArtifact` already drops these while unzipping. The guard stays because
 * this is the boundary that actually creates files: it has to live where the
 * damage would be done, not where the bytes happened to come from.
 */
function assertSafeEntry(path: string): void {
  const unsafe =
    path.length === 0 ||
    path.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
  if (unsafe) {
    throw new SkillMaterializeError(
      "unsafe_entry",
      `Refusing archive entry "${path}": absolute, traversing, or not a file`,
      "The published artifact is malformed. Re-publish the skill from Appstrate.",
    );
  }
}

export interface MaterializeSkillInput {
  /** Directory name the skill is written under; also its frontmatter `name`. */
  slug: string;
  /** Every entry of the artifact, packaging files included. */
  files: Record<string, Uint8Array>;
}

/**
 * Produce the files of one skill directory, keyed by path relative to it, in
 * sorted key order so callers that iterate (writing to disk, hashing) see a
 * stable sequence without re-sorting.
 */
export function materializeSkill(input: MaterializeSkillInput): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (const path of Object.keys(input.files).sort()) {
    assertSafeEntry(path);
    if (DROPPED_ENTRIES.has(path)) continue;
    const bytes = input.files[path]!;
    out[path] =
      path === SKILL_ENTRY
        ? encoder.encode(normalizeSkillMd(decoder.decode(bytes), input.slug))
        : bytes;
  }

  if (!out[SKILL_ENTRY]) {
    throw new SkillMaterializeError(
      "empty_artifact",
      `Artifact contains no ${SKILL_ENTRY}`,
      "Every Appstrate skill stores its body as SKILL.md — the artifact is malformed.",
    );
  }
  return out;
}

/**
 * Point the frontmatter `name` at the directory the skill is written under —
 * the one rewrite the Agent Skills spec forces, since it requires `name` to
 * equal the parent directory name. Every other byte passes through as
 * authored: unknown keys are Claude Code's own extensions, and a description
 * the sync invented would hide a publishing mistake from the only person who
 * can fix it.
 */
export function normalizeSkillMd(content: string, slug: string): string {
  if (extractSkillMeta(content).name === slug) return content;
  const match = content.match(FRONTMATTER_RE);
  if (!match) return content;

  // Splice by offset rather than `String.replace`: the block is user content
  // that could recur later in the document, and a replacement would also
  // re-interpret `$` sequences.
  const blockStart = match[0]!.indexOf("\n") + 1;
  const block = match[1]!;
  const line = /^name:[^\r\n]*/m.exec(block);
  if (!line) {
    const eol = block.includes("\r\n") ? "\r\n" : "\n";
    return `${content.slice(0, blockStart)}name: ${slug}${eol}${content.slice(blockStart)}`;
  }
  const at = blockStart + line.index;
  return `${content.slice(0, at)}name: ${slug}${content.slice(at + line[0].length)}`;
}

/**
 * The frontmatter block. Same anchor `extractSkillMeta` uses, so "which block
 * is the frontmatter" has exactly one answer across the CLI and the platform.
 */
const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---/;
