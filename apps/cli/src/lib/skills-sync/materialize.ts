// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate skill package → Agent Skills directory.
 *
 * The pure half of `appstrate skills sync`: given the files of one skill
 * artifact, produce the exact bytes of the directory Claude Code and Codex
 * will read. No network, no filesystem — so every rule below is unit-testable
 * on its own.
 *
 * Three rules carry the whole translation:
 *
 *  - **The directory name is the skill's identity.** The Agent Skills spec
 *    requires the frontmatter `name` to equal the parent directory name, and
 *    Claude Code derives the `/appstrate:<name>` command from it. Appstrate
 *    ids are `@scope/name`, which is not a legal skill name, and Appstrate
 *    only ever checked that the frontmatter `name` is non-empty — so a slug
 *    has to be derived, and the frontmatter rewritten to agree with it.
 *  - **Rewrite the minimum.** `name` is replaced only when it differs from
 *    the slug; `description` is injected only when the skill has none (both
 *    Codex and the spec require it). Every other byte of `SKILL.md` — and
 *    every other file — passes through verbatim, because unknown frontmatter
 *    keys are Claude Code's own extensions and dropping them would silently
 *    change behaviour.
 *  - **The output is a function of the input.** No timestamps, no sync
 *    metadata, sorted keys. A `mode: "copy"` plugin's version IS the hash of
 *    its contents, so a byte-identical re-run must hash identically or every
 *    session would install a "new" plugin version.
 */

import { extractSkillMeta } from "@appstrate/core/validation";
import { SLUG_REGEX, toSlug } from "@appstrate/core/naming";

/**
 * Spec ceiling on a skill name (agentskills.io/specification: 1-64 chars,
 * `[a-z0-9-]`, no leading or trailing hyphen). The CHARSET half of that rule
 * is `SLUG_REGEX` from `@appstrate/core/naming`, reused rather than restated:
 * every value checked here has been through `toSlug`, which collapses runs of
 * non-alphanumerics to a single hyphen, so the two accept exactly the same
 * strings. Only the length cap is local, because `SLUG_REGEX` has none.
 */
const SKILL_NAME_MAX_LEN = 64;

/** A slugified value that is a legal Agent Skills `name`. */
function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= SKILL_NAME_MAX_LEN && SLUG_REGEX.test(value);
}

/**
 * ZIP entries that are Appstrate packaging, not skill content.
 *
 * `manifest.json` is the AFPS manifest — its `description` is consumed for the
 * frontmatter injection below and then dropped; shipping it would put an
 * Appstrate-shaped file in a directory Claude Code and Codex scan. `RECORD` is
 * the packaging checksum listing, meaningless once the archive is unpacked.
 *
 * Exported because the draft path in `./plan.ts` must know the same set BEFORE
 * fetching: on that path each file is a separate rate-limited request, so
 * "drop it after downloading it" is two wasted round-trips per skill. One
 * definition, or the two lists drift and the draft tree stops matching the
 * published one.
 */
export const DROPPED_ENTRIES: ReadonlySet<string> = new Set(["manifest.json", "RECORD"]);

/**
 * The one file an Agent Skills directory must contain — and therefore the one
 * that proves a materialized skill is actually present on disk. Exported for
 * that second reason: `commands/skills.ts` tests for it rather than for the
 * directory, because a directory can survive its `SKILL.md`.
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
 * Preference order is frontmatter `name` → the package's `name` segment,
 * because the frontmatter name is what the author typed and what Appstrate
 * shows; the package segment is already slug-shaped and makes a reliable
 * fallback for a skill whose frontmatter name slugifies to nothing (e.g. a
 * name written entirely in a non-Latin script).
 */
export function skillSlug(frontmatterName: string, packageNameSegment: string): string {
  const fromFrontmatter = toSlug(frontmatterName, SKILL_NAME_MAX_LEN).replace(/-+$/, "");
  if (isSkillName(fromFrontmatter)) return fromFrontmatter;
  const fromPackage = toSlug(packageNameSegment, SKILL_NAME_MAX_LEN).replace(/-+$/, "");
  if (isSkillName(fromPackage)) return fromPackage;
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
 * name never depends on server ordering or on which skill was published
 * first.
 *
 * The numeric tail is not paranoia: `@a/b` named "Acme Foo", `@acme/bar` named
 * "Foo" and `@acme/foo` named "Foo" all reduce to `acme-foo` — the first via
 * its frontmatter, the other two via this fallback. Returning a duplicate
 * would hand two skills the same directory and abort the whole sync on the
 * `wx` write.
 */
export function collisionSlug(packageId: string, taken: ReadonlySet<string>): string {
  const withoutAt = packageId.replace(/^@/, "").replace("/", "-");
  const base = toSlug(withoutAt, SKILL_NAME_MAX_LEN).replace(/-+$/, "");
  if (!isSkillName(base)) {
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
    const head = base.slice(0, SKILL_NAME_MAX_LEN - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate) && isSkillName(candidate)) return candidate;
  }
}

/**
 * Reject an archive entry path that must never reach the filesystem.
 *
 * `unzipArtifact` already drops these while unzipping, so nothing here is
 * expected to fire on a well-formed artifact. It stays because that filter is
 * one library away from the `writeFile` call and this is the boundary that
 * actually creates files: the guard has to live where the damage would be
 * done, not where the bytes happened to come from.
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
  /**
   * `description` from the AFPS manifest, injected into the frontmatter when
   * the skill declares none. Empty when the manifest has none either — the
   * resulting skill is then missing a field the spec requires, which is the
   * author's to fix and not something the sync should invent text for.
   */
  manifestDescription: string;
}

/**
 * Produce the files of one skill directory, keyed by path relative to it.
 *
 * Insertion order is sorted so callers that iterate (writing to disk, hashing)
 * see a stable sequence without having to re-sort.
 */
export function materializeSkill(input: MaterializeSkillInput): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();

  for (const path of Object.keys(input.files).sort()) {
    assertSafeEntry(path);
    if (DROPPED_ENTRIES.has(path)) continue;
    const bytes = input.files[path]!;
    out[path] =
      path === SKILL_ENTRY
        ? encoder.encode(
            normalizeSkillMd(
              new TextDecoder().decode(bytes),
              input.slug,
              input.manifestDescription,
            ),
          )
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
 * Rewrite `SKILL.md`'s frontmatter to the two invariants the consumers
 * enforce, and nothing else.
 *
 * A file with no frontmatter block at all gets one — Claude Code and Codex
 * both skip a `SKILL.md` without it, so passing it through verbatim would
 * materialize a directory neither tool loads.
 *
 * Replacement is by ENTRY, not by line: YAML lets a value span the key line
 * plus an indented continuation block (`description:` followed by two indented
 * lines, a `|` literal, a `>` folded scalar, a nested mapping). Overwriting
 * only the key line would leave those continuation lines behind as an
 * unparseable fragment — turning a skill with an unusual description into a
 * skill Claude Code refuses to load at all.
 */
export function normalizeSkillMd(
  content: string,
  slug: string,
  manifestDescription: string,
): string {
  // A UTF-8 BOM defeats every `^---` anchor here and in `extractSkillMeta`,
  // so a BOM'd file would be read as having no frontmatter and get a second
  // one prepended. Strip it once, and do not re-emit it: nothing downstream
  // wants it, and its only effect was to break the parse.
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  // CRLF is normalized away for the whole pass and restored on the way out.
  // Scanning it in place does not work: a JS `.` excludes `\r`, so every
  // key-line regex here (and in `extractSkillMeta`) silently matched nothing
  // on a CRLF file, `scanEntries` returned zero entries, and the name rewrite
  // prepended a SECOND `name:` key instead of replacing the first.
  const eol = /^[^\n]*\r\n/.test(stripped) ? "\r\n" : "\n";
  const text = eol === "\r\n" ? stripped.replace(/\r\n/g, "\n") : stripped;
  const restore = (value: string): string =>
    eol === "\r\n" ? value.replace(/\n/g, "\r\n") : value;

  const meta = extractSkillMeta(text);
  // Same anchor `extractSkillMeta` uses, so "which block is the frontmatter"
  // has exactly one answer across the CLI and the platform.
  const match = text.match(/^---[^\S\n]*\n([\s\S]*?)\n---/);

  if (!match) {
    const header = [
      "---",
      `name: ${slug}`,
      `description: ${yamlString(manifestDescription)}`,
      "---",
      "",
    ];
    return restore(`${header.join("\n")}\n${text}`);
  }

  const block = match[1]!;
  let lines = block.split("\n");
  const entries = scanEntries(lines);
  const nameEntry = entries.find((e) => e.key === "name");
  const descEntry = entries.find((e) => e.key === "description");

  // A description that spans a continuation block is PRESENT even though
  // `extractSkillMeta`'s single-line regex cannot read it. Injecting the
  // manifest's on top would duplicate the key.
  const hasDescription = meta.description.length > 0 || descEntry?.hasBlock === true;

  const edits: { start: number; end: number; line: string }[] = [];
  let prepend: string | null = null;
  let append: string | null = null;
  if (meta.name !== slug) {
    const line = `name: ${slug}`;
    if (nameEntry) edits.push({ start: nameEntry.start, end: nameEntry.end, line });
    else prepend = line;
  }
  if (!hasDescription && manifestDescription.length > 0) {
    const line = `description: ${yamlString(manifestDescription)}`;
    if (descEntry) edits.push({ start: descEntry.start, end: descEntry.end, line });
    else append = line;
  }
  // Splices first, bottom-up, so each recorded range is still valid when its
  // turn comes. Only THEN the prepend: inserting a line ahead of the block
  // shifts every recorded index by one, and doing it first made the
  // description splice overwrite the name line it had just added.
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    lines.splice(edit.start, edit.end - edit.start + 1, edit.line);
  }
  if (prepend !== null) lines = [prepend, ...lines];
  if (append !== null) lines = [...lines, append];

  const rewritten = lines.join("\n");
  if (rewritten === block) return restore(text);
  // Splice by offset rather than `text.replace(block, …)`: the block text is
  // user content and could legitimately recur later in the document, and a
  // string replacement would also re-interpret `$` sequences in `rewritten`.
  // The frontmatter regex is anchored at the start, so `match.index` is 0 and
  // the block begins right after the opening `---` line.
  const blockStart = match[0]!.indexOf("\n") + 1;
  return restore(text.slice(0, blockStart) + rewritten + text.slice(blockStart + block.length));
}

/** One top-level frontmatter key and the lines its value occupies. */
interface FrontmatterEntry {
  key: string;
  /** Index of the `key:` line within the block. */
  start: number;
  /** Index of the last line belonging to this entry (== `start` when inline). */
  end: number;
  /** True when the value continues onto indented lines below the key. */
  hasBlock: boolean;
}

/**
 * Locate every top-level key in a frontmatter block and the extent of its
 * value. Deliberately not a YAML parser: it only needs to answer "which lines
 * would I destroy if I overwrote this key", and the indentation rule answers
 * that for block scalars, folded scalars and nested mappings alike.
 */
function scanEntries(lines: string[]): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  const keyLine = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(keyLine);
    if (!match) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (/^\s+\S/.test(line)) {
        end = j;
        continue;
      }
      // A blank line belongs to the entry only when an indented line follows
      // it — that is a paragraph break inside a block scalar, not the end of
      // the value.
      if (line.trim() === "") {
        const next = lines.slice(j + 1).find((l) => l.trim() !== "");
        if (next !== undefined && /^\s+\S/.test(next)) continue;
      }
      break;
    }
    entries.push({ key: match[1]!, start: i, end, hasBlock: end > i });
    i = end;
  }
  return entries;
}

/**
 * Emit a value as a double-quoted YAML scalar.
 *
 * Manifest descriptions are free text — a leading `[`, an embedded `: `, or a
 * newline each break a plain scalar in a different way, and one of them turns
 * the whole frontmatter block into a parse error rather than a bad field.
 * Quoting unconditionally costs nothing and has one behaviour.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
    .trim();
  return `"${escaped}"`;
}
