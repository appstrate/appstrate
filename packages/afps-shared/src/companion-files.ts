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
 *     (§3.3). Missing `description` is tolerated — this is the LOADER gate;
 *     the producer rule is {@link checkSkillMarkdown}.
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
 * Deliberately NOT {@link parseSkillFrontmatter}: published artifacts exist
 * whose frontmatter `yaml` cannot parse at all (17 in production at the time of
 * writing, each an unquoted `description: … : …`) and the run launcher has to
 * keep serving them, so this probe's acceptance set may never shrink.
 */
function hasFrontmatterName(content: string): boolean {
  const fmMatch = content.match(/^---[^\S\n]*\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;
  const fm = fmMatch[1] ?? "";
  const nameMatch = fm.match(/name:[ \t]*(.+)/);
  if (!nameMatch) return false;
  const raw = (nameMatch[1] ?? "").trim();
  if (raw.length === 0) return false;
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  const value = unquoted ? unquoted[2] : raw;
  return (value ?? "").trim().length > 0;
}

/** Agent Skills bounds, in code points. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** The bare slug an agent runtime addresses — NOT a `@scope/name` package id. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function codePointLength(value: string): number {
  return [...value].length;
}

export function isValidSkillName(name: string): boolean {
  return codePointLength(name) <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}

/** Parsed `SKILL.md` frontmatter. Never throws; a parse failure is `error`. */
export interface SkillFrontmatter {
  found: boolean;
  /** Opens with `---` but never closes the block. */
  unterminated: boolean;
  error: string | null;
  name: string;
  description: string;
}

/** Parses the way the skill runtime does, so the gate cannot accept what it fails to read. */
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

/** An absent key and an empty scalar both mean "not provided" and yield `""`. */
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

function startsWithBom(content: string): boolean {
  return content.charCodeAt(0) === 0xfeff;
}

/** `ignoreBOM: true` reads backwards: it means "do not CONSUME the BOM". */
export function decodeSkillMarkdown(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.trim();
}

/**
 * The producer-side AFPS §3.3 gate: an Agent Skills `name`
 * (https://agentskills.io/specification) plus a non-empty bounded `description`.
 */
export function checkSkillMarkdown(content: string): CompanionFileViolation | null {
  // Rejected rather than stripped: Pi reads no frontmatter behind a BOM and
  // drops the skill, while the platform's loader eats it — so the version
  // would be minted, immutable, and simply never load.
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

  // Containment: `name:\n  triage` is valid YAML the loader's probe cannot
  // read, so accepting it would mint a version the run launcher cannot load.
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
