// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of `appstrate skills sync`. Output is a function of the input —
 * sorted keys, no timestamps — because a `mode: "copy"` plugin's version IS the
 * hash of its contents, so a byte-identical re-run must hash identically.
 */

import { isValidSkillName, SKILL_NAME_MAX_LENGTH } from "@appstrate/afps-shared/companion-files";
import { extractSkillMeta } from "@appstrate/core/validation";
import { toSlug } from "@appstrate/core/naming";

/**
 * Appstrate packaging, not skill content. Exported because the draft path must
 * know the same set BEFORE fetching: each file there is its own request.
 */
export const DROPPED_ENTRIES: ReadonlySet<string> = new Set(["manifest.json", "RECORD"]);

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
 * The frontmatter `name` wins when legal — the platform enforces that on every
 * write. Legacy artifacts fall back to the package's `name` segment.
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
 * `<scope>-<name>`, then `-2`, `-3`, … until free, applied to the later of two
 * claimants. The counter is load-bearing: `<scope>-<name>` can itself collide,
 * and a duplicate would abort the whole sync on the `wx` write.
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

/** `unzipArtifact` drops these too; the guard belongs where files are created. */
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
  slug: string;
  files: Record<string, Uint8Array>;
}

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
 * Point the frontmatter `name` at the directory — the one rewrite the spec
 * forces. Every other byte passes through as authored: unknown keys are Claude
 * Code's extensions, and invented content would hide a publishing mistake.
 */
export function normalizeSkillMd(content: string, slug: string): string {
  if (extractSkillMeta(content).name === slug) return content;
  const match = content.match(FRONTMATTER_RE);
  if (!match) return content;

  // Splice by offset, not `String.replace`: the block is user content that can
  // recur later, and a replacement would re-interpret `$` sequences.
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

const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---/;
