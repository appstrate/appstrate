// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Companion-file enforcement shared between the platform's ZIP-import path
 * (`@appstrate/core/zip:parsePackageZip`) and the runtime's bundle loader
 * (`@appstrate/afps-runtime/bundle/build:extractRootFromAfps`).
 *
 * This is the SINGLE source of truth for the §3.3 / §3.4 companion-file
 * invariants. Both call sites import THIS module directly — there is no
 * intermediate re-export to drift against:
 *   - `packages/core/src/zip.ts` calls `checkCompanionFiles` +
 *     `companionFilesFromRecord` inline (core no longer publishes a
 *     `./companion-files` subpath — removed in core 6.0.0).
 *   - `packages/afps-runtime/src/bundle/companion-files.ts` is a thin
 *     internal adapter (Map-accepting, throws `BundleError`) consumed by
 *     `bundle/validate-bundle.ts`; it is not a package subpath either.
 */

import { parse as parseYaml } from "yaml";

/**
 * Stable, machine-readable companion-file violation reasons.
 */
export type CompanionViolationReason =
  | "AGENT_MISSING_PROMPT"
  | "AGENT_EMPTY_PROMPT"
  | "SKILL_MISSING_SKILL_MD"
  | "SKILL_INVALID_FRONTMATTER"
  | "SKILL_MISSING_FRONTMATTER_NAME"
  | "SKILL_INVALID_FRONTMATTER_NAME"
  | "SKILL_MISSING_FRONTMATTER_DESCRIPTION"
  | "SKILL_INVALID_FRONTMATTER_DESCRIPTION"
  | "MCP_SERVER_MISSING_ENTRY_POINT";

/**
 * Structured error type for callers that want to translate companion-file
 * violations into their own error class (e.g. `PackageZipError` on the
 * platform side, `BundleError` on the runtime side). Throwing is left to
 * the caller so we don't couple this module to a specific error hierarchy.
 */
export interface CompanionFileViolation {
  /** Stable, machine-readable reason. */
  reason: CompanionViolationReason;
  /** Human-readable description. */
  message: string;
  /** Path the violation refers to, when relevant. */
  path?: string;
}

/**
 * Minimal file-list abstraction. The platform side stores files in a
 * `Record<string, Uint8Array>`; the runtime side stores them in a
 * `Map<string, Uint8Array>`. This adapter lets both call the same checker.
 */
export interface CompanionFileSource {
  /** Does the archive contain a file at `path`? */
  has(path: string): boolean;
  /** Read bytes at `path`, or undefined when absent. */
  get(path: string): Uint8Array | undefined;
}

/** Build a {@link CompanionFileSource} from a `Map<string, Uint8Array>`. */
export function companionFilesFromMap(files: Map<string, Uint8Array>): CompanionFileSource {
  return {
    has: (p) => files.has(p),
    get: (p) => files.get(p),
  };
}

/** Build a {@link CompanionFileSource} from a `Record<string, Uint8Array>`. */
export function companionFilesFromRecord(files: Record<string, Uint8Array>): CompanionFileSource {
  return {
    has: (p) => Object.prototype.hasOwnProperty.call(files, p),
    get: (p) => files[p],
  };
}

/**
 * Validate companion-file presence per AFPS §3.3 / §3.4 for the given
 * package type. Returns the first violation encountered, or `null` when
 * the archive is consistent with the declared type.
 *
 * The check is intentionally minimal and presence-focused:
 *   - `agent` → `prompt.md` present at root, non-empty bytes (§3.2).
 *   - `skill` → `SKILL.md` present at root, with a YAML frontmatter `name`
 *     (§3.3). Missing `description` is tolerated here: this function is the
 *     LOADER-side gate. The stricter producer-side rule lives in
 *     {@link checkSkillMarkdown}.
 *   - `mcp-server` → file at `manifest.server.entry_point` present in the
 *     archive (§3.4 "self-contained — every runtime dep bundled").
 *   - `integration` → no required companion (§3.5).
 *   - any other type → no check (caller validates manifest shape).
 *
 * The caller is responsible for throwing whatever error class fits its
 * domain (e.g. `PackageZipError` for HTTP imports, `BundleError` for the
 * runtime loader).
 */
export function checkCompanionFiles(
  manifest: { type?: unknown; server?: unknown } & Record<string, unknown>,
  files: CompanionFileSource,
): CompanionFileViolation | null {
  const type = manifest.type;

  if (type === "agent") {
    const bytes = files.get("prompt.md");
    if (!bytes) {
      return {
        reason: "AGENT_MISSING_PROMPT",
        message: "agent package must contain prompt.md at the archive root",
        path: "prompt.md",
      };
    }
    if (isEffectivelyEmpty(bytes)) {
      return {
        reason: "AGENT_EMPTY_PROMPT",
        message: "agent prompt.md must not be empty or whitespace-only",
        path: "prompt.md",
      };
    }
    return null;
  }

  if (type === "skill") {
    const bytes = files.get("SKILL.md");
    if (!bytes) {
      return {
        reason: "SKILL_MISSING_SKILL_MD",
        message: "skill package must contain SKILL.md at the archive root",
        path: "SKILL.md",
      };
    }
    if (!hasFrontmatterName(new TextDecoder().decode(bytes))) {
      return {
        reason: "SKILL_MISSING_FRONTMATTER_NAME",
        message: "skill SKILL.md must declare a 'name' in YAML frontmatter",
        path: "SKILL.md",
      };
    }
    return null;
  }

  if (type === "mcp-server") {
    const server = manifest.server as { entry_point?: unknown } | undefined;
    const entryPoint = server?.entry_point;
    if (typeof entryPoint !== "string" || entryPoint.length === 0) {
      // Manifest schema validation reports this — surface a structured
      // violation here too so callers that skip schema validation still
      // catch it.
      return {
        reason: "MCP_SERVER_MISSING_ENTRY_POINT",
        message: "mcp-server manifest must declare server.entry_point",
      };
    }
    if (!files.has(entryPoint)) {
      return {
        reason: "MCP_SERVER_MISSING_ENTRY_POINT",
        message: `mcp-server archive missing server.entry_point payload: ${entryPoint}`,
        path: entryPoint,
      };
    }
    return null;
  }

  // `integration` and unknown/missing types: no companion-file requirement
  // here. The caller's manifest schema check rejects unsupported types.
  return null;
}

function isEffectivelyEmpty(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  // Avoid decoding very large buffers just to call trim — short-circuit
  // when any byte is not whitespace.
  for (const b of bytes) {
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20) return false;
  }
  return true;
}

/**
 * Loader-side name probe, deliberately not routed through
 * {@link parseSkillFrontmatter}: it decides whether an already-published —
 * therefore immutable — bundle loads, so its acceptance set may never shrink.
 * The parser reads only column-0 keys and would newly reject `  name: x`,
 * `metadata:\n  name: x` and `skill_name: x`, which some published artifact may
 * well contain.
 */
function hasFrontmatterName(content: string): boolean {
  const fmMatch = content.match(/^---[^\S\n]*\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;
  const fm = fmMatch[1] ?? "";
  const nameMatch = fm.match(/name:[ \t]*(.+)/);
  if (!nameMatch) return false;
  const raw = (nameMatch[1] ?? "").trim();
  if (raw.length === 0) return false;
  // Strip surrounding quotes, the way a YAML quoted scalar would be read.
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  const value = unquoted ? unquoted[2] : raw;
  return (value ?? "").trim().length > 0;
}

// ─────────────────────────────────────────────
// SKILL.md YAML frontmatter — the producer-side parser
// ─────────────────────────────────────────────

/** Agent Skills `name` bound, in Unicode code points. */
export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * Agent Skills `description` bound, in Unicode code points — the spec counts
 * characters. Pi measures UTF-16 units and only warns past the bound; the
 * platform enforces the spec, because the artifact it mints is immutable.
 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Agent Skills `name` rule: lowercase `a-z`, `0-9` and `-`, no leading,
 * trailing or consecutive hyphen. Length is checked separately so the
 * violation message can name the bound.
 *
 * A different namespace from a package id (`@scope/name` under `SLUG_PATTERN`,
 * unbounded and `--`-tolerant): this is the bare skill slug an agent runtime
 * addresses. Neither validator may be substituted for the other.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Length in Unicode code points — `"🙂".length` is 2, this returns 1. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** Does `name` satisfy the Agent Skills `name` rule (shape AND length)? */
export function isValidSkillName(name: string): boolean {
  return codePointLength(name) <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}

/** Parsed `SKILL.md` YAML frontmatter. */
export interface SkillFrontmatter {
  /** Whether a closed `--- … ---` frontmatter block was found. */
  found: boolean;
  /** The document opens with `---` but never closes the block. */
  unterminated: boolean;
  /**
   * Why the block could not be read as `{ name, description }`, or `null`.
   * Never thrown: `extractSkillMeta` degrades to empty fields plus a warning.
   */
  error: string | null;
  /** Frontmatter `name`, or `""` when absent/blank. */
  name: string;
  /** Frontmatter `description`, or `""` when absent/blank. */
  description: string;
}

/**
 * Parse the `name` / `description` of a `SKILL.md` YAML frontmatter block.
 *
 * Parity with the consumer is the point: the runtime that loads a skill
 * (`@earendil-works/pi-coding-agent`, `dist/utils/frontmatter.js`) normalises
 * newlines, requires a leading `---`, cuts the block at the first `\n---` and
 * hands the slice to `yaml`'s `parse`. This does the same against the same
 * library at the same major, so the gate cannot accept a document the consumer
 * then fails to parse. `uniqueKeys` and `strict` are passed explicitly so a
 * future default change cannot loosen the gate in silence.
 *
 * Nothing the runtime keeps is normalised away — a leading BOM above all: Pi
 * tests `startsWith("---")`, so it reads no frontmatter behind one, and a
 * parser that saw through it would report fields the runtime never sees.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const empty = { found: false, unterminated: false, error: null, name: "", description: "" };

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return empty;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { ...empty, unterminated: true };

  const block = normalized.slice(4, endIndex);

  let parsed: unknown;
  try {
    parsed = parseYaml(block, { uniqueKeys: true, strict: true });
  } catch (err) {
    return {
      ...empty,
      found: true,
      error: `frontmatter is not valid YAML: ${firstLine(err)}`,
    };
  }

  // An empty block yields `null`; the runtime coerces that to `{}` and so do
  // we, which makes it a missing NAME rather than a malformed document.
  const mapping = parsed ?? {};
  if (typeof mapping !== "object" || Array.isArray(mapping)) {
    return {
      ...empty,
      found: true,
      error: "frontmatter is not valid YAML: expected a mapping of keys to values",
    };
  }

  const record = mapping as Record<string, unknown>;
  const name = readStringField(record, "name");
  if (typeof name !== "string") return { ...empty, found: true, error: name.error };
  const description = readStringField(record, "description");
  if (typeof description !== "string") return { ...empty, found: true, error: description.error };

  return { found: true, unterminated: false, error: null, name, description };
}

/**
 * Read one frontmatter field as a trimmed string. An absent key and an empty
 * scalar (`description:` / `description: null`) both mean "not provided" and
 * yield `""`; any other non-string is a malformed document.
 */
function readStringField(record: Record<string, unknown>, key: string): string | { error: string } {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    return {
      error: `frontmatter is not valid YAML: '${key}' must be a string, got ${describeType(value)}`,
    };
  }
  return value.trim();
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return `a ${typeof value}`;
}

/** Does the text begin with a UTF-8 byte-order mark? */
function startsWithBom(content: string): boolean {
  return content.charCodeAt(0) === 0xfeff;
}

/**
 * Decode `SKILL.md` bytes for {@link checkSkillMarkdown}. `ignoreBOM: true`
 * reads backwards: it means "do not CONSUME the BOM". A default `TextDecoder`
 * swallows it, which would hand the gate a BOM-free string and freeze bytes
 * the runtime cannot read.
 */
export function decodeSkillMarkdown(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** First line of an error message — YAML errors carry a multi-line excerpt. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.trim();
}

// ─────────────────────────────────────────────
// SKILL.md — the producer-side gate
// ─────────────────────────────────────────────

/**
 * Validate a `SKILL.md`'s frontmatter against the full AFPS §3.3 rule, as a
 * producer must: a `name` conforming to the Agent Skills specification
 * (https://agentskills.io/specification) and a non-empty `description` of at
 * most {@link SKILL_DESCRIPTION_MAX_LENGTH} code points. Returns the first
 * violation, or `null`.
 *
 * Separate from {@link checkCompanionFiles} because that one also runs on the
 * loader side, over already-published immutable bundles: a skill published
 * before this rule existed must keep loading. AFPS spells both fields SHOULD;
 * the platform mints these artifacts and holds itself to MUST.
 */
export function checkSkillMarkdown(content: string): CompanionFileViolation | null {
  // First, because everything below would read a document the runtime cannot:
  // Pi reads no frontmatter behind a BOM and drops the skill, while the
  // platform's own loader eats the BOM — so nothing downstream would complain
  // and the version would be minted, immutable, and never load. Rejected
  // rather than stripped, so the artifact still matches the file the author
  // wrote.
  if (startsWithBom(content)) {
    return {
      reason: "SKILL_INVALID_FRONTMATTER",
      message:
        "skill SKILL.md starts with a byte-order mark (U+FEFF); remove it — " +
        "the runtime cannot read frontmatter behind a BOM",
      path: "SKILL.md",
    };
  }

  const { unterminated, error, name, description } = parseSkillFrontmatter(content);

  if (unterminated) {
    return {
      reason: "SKILL_MISSING_FRONTMATTER_NAME",
      message: "skill SKILL.md frontmatter block is not closed (expected a second '---' line)",
      path: "SKILL.md",
    };
  }
  if (error) {
    return {
      reason: "SKILL_INVALID_FRONTMATTER",
      message: `skill SKILL.md ${error}`,
      path: "SKILL.md",
    };
  }
  if (!name) {
    return {
      reason: "SKILL_MISSING_FRONTMATTER_NAME",
      message: "skill SKILL.md must declare a 'name' in YAML frontmatter",
      path: "SKILL.md",
    };
  }
  if (!isValidSkillName(name)) {
    return {
      reason: "SKILL_INVALID_FRONTMATTER_NAME",
      message:
        `skill SKILL.md 'name' must be 1-${SKILL_NAME_MAX_LENGTH} characters of lowercase ` +
        `a-z, 0-9 and '-', with no leading or trailing hyphen and no consecutive hyphens ` +
        `(got '${name}')`,
      path: "SKILL.md",
    };
  }
  if (!description) {
    return {
      reason: "SKILL_MISSING_FRONTMATTER_DESCRIPTION",
      message: "skill SKILL.md must declare a non-empty 'description' in YAML frontmatter",
      path: "SKILL.md",
    };
  }
  const descriptionLength = codePointLength(description);
  if (descriptionLength > SKILL_DESCRIPTION_MAX_LENGTH) {
    return {
      reason: "SKILL_INVALID_FRONTMATTER_DESCRIPTION",
      message:
        `skill SKILL.md 'description' must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} ` +
        `characters (got ${descriptionLength})`,
      path: "SKILL.md",
    };
  }

  // Containment: what this gate accepts must be a SUBSET of what the loader
  // accepts. YAML is the more permissive of the two — `name:\n  triage` and
  // `name : triage` are valid YAML the substring probe cannot see — so without
  // this check, publishing would mint an immutable version the run launcher
  // then refuses to load.
  if (!hasFrontmatterName(content)) {
    return {
      reason: "SKILL_INVALID_FRONTMATTER_NAME",
      message:
        `skill SKILL.md 'name' must be written inline on one line, e.g. "name: my-skill" ` +
        `(a name on a following line, or a space before the colon, makes the platform's ` +
        `package loader unable to read it)`,
      path: "SKILL.md",
    };
  }
  return null;
}
