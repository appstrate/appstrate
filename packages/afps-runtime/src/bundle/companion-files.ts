// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Companion-file enforcement for the `.afps` / `.afps-bundle` loader paths.
 *
 * Mirror of `@appstrate/core/companion-files`. `@appstrate/afps-runtime`
 * intentionally avoids an `@appstrate/core` runtime dependency to stay
 * portable + standalone (see `archive-utils.ts`), so we maintain a local
 * Map-based copy of the algorithm. Keep the two in sync — there is a
 * sanitizer-parity-style test that asserts both reject the same inputs.
 *
 * Spec references: §3.3 (skill SKILL.md + frontmatter `name`), §3.4 (agent
 * prompt.md non-empty; mcp-server `server.entry_point` payload present in
 * the archive).
 */

import { BundleError } from "./errors.ts";

export type CompanionViolationReason =
  | "AGENT_MISSING_PROMPT"
  | "AGENT_EMPTY_PROMPT"
  | "SKILL_MISSING_SKILL_MD"
  | "SKILL_MISSING_FRONTMATTER_NAME"
  | "MCP_SERVER_MISSING_ENTRY_POINT";

export interface CompanionViolation {
  reason: CompanionViolationReason;
  message: string;
  path?: string;
}

/**
 * Validate companion-file presence per AFPS §3.3 / §3.4 for the given
 * package type. Returns the first violation or `null`.
 *
 *   - `agent` → `prompt.md` present at root, non-empty bytes.
 *   - `skill` → `SKILL.md` present at root + YAML frontmatter `name`
 *     (description is tolerated missing per spec).
 *   - `mcp-server` → file at `manifest.server.entry_point` present.
 *   - `integration` → no required companion.
 */
export function checkCompanionFiles(
  manifest: { type?: unknown; server?: unknown } & Record<string, unknown>,
  files: Map<string, Uint8Array>,
): CompanionViolation | null {
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

  return null;
}

/**
 * Convenience wrapper: run {@link checkCompanionFiles} and throw a
 * structured {@link BundleError} on violation. Both single-package
 * `.afps` and multi-package `.afps-bundle` callers use this so the error
 * surface is uniform.
 */
export function assertCompanionFiles(
  manifest: { type?: unknown; server?: unknown } & Record<string, unknown>,
  files: Map<string, Uint8Array>,
): void {
  const violation = checkCompanionFiles(manifest, files);
  if (!violation) return;
  throw new BundleError("ARCHIVE_INVALID", violation.message, {
    reason: violation.reason,
    path: violation.path,
  });
}

function isEffectivelyEmpty(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
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
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  const value = unquoted ? unquoted[2] : raw;
  return (value ?? "").trim().length > 0;
}
