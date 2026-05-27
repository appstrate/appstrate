// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Companion-file enforcement shared between the platform's ZIP-import path
 * (`@appstrate/core/zip:parsePackageZip`) and the runtime's bundle loader
 * (`@appstrate/afps-runtime/bundle/build:extractRootFromAfps`).
 *
 * This is the SINGLE source of truth for the §3.3 / §3.4 companion-file
 * invariants. Both `@appstrate/core/companion-files` and
 * `@appstrate/afps-runtime/bundle/companion-files` re-export from here, so
 * the two call sites can never drift.
 */

/**
 * Stable, machine-readable companion-file violation reasons.
 */
export type CompanionViolationReason =
  | "AGENT_MISSING_PROMPT"
  | "AGENT_EMPTY_PROMPT"
  | "SKILL_MISSING_SKILL_MD"
  | "SKILL_MISSING_FRONTMATTER_NAME"
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
 *   - `skill` → `SKILL.md` present at root, with YAML frontmatter `name`
 *     (§3.3). Missing `description` is tolerated per spec.
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

function hasFrontmatterName(content: string): boolean {
  const fmMatch = content.match(/^---[^\S\n]*\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;
  const fm = fmMatch[1] ?? "";
  const nameMatch = fm.match(/name:[ \t]*(.+)/);
  if (!nameMatch) return false;
  const raw = (nameMatch[1] ?? "").trim();
  if (raw.length === 0) return false;
  // Strip surrounding quotes to mirror extractSkillMeta's stripQuotes.
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  const value = unquoted ? unquoted[2] : raw;
  return (value ?? "").trim().length > 0;
}
