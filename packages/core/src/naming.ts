// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  allocateMcpToolNamespace,
  MCP_TOOL_NAME_MAX_LENGTH,
  normaliseMcpToolBody,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";

export { allocateMcpToolNamespace, normaliseMcpToolBody, normaliseMcpToolNamespace };

/** Regex pattern string for a valid slug: lowercase alphanumeric with optional hyphens. */
export const SLUG_PATTERN = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
/** Compiled regex for validating a single slug string. */
export const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);

/**
 * Canonical snake_case identifier pattern: a lowercase letter followed by
 * lowercase alphanumerics and underscores. Single source of truth for every
 * `^[a-z][a-z0-9_]*$` check in the codebase (previously re-declared verbatim
 * in `apps/web/src/lib/strings.ts` and inline Zod in the API).
 *
 * Two distinct concepts share this exact alphabet:
 *  - **Credential / AFPS auth keys** — the sidecar substitution contract
 *    (`\w+`, hyphens disallowed); consumed by the web credentials editor and
 *    the API's system-integration `auth_key` gate (AFPS §7.2).
 *  - **MCP tool-name inner tokens** — each half of a `{ns}__{tool}` name
 *    (see {@link TOOL_NAME_INNER_PATTERN}, which aliases this).
 */
export const CREDENTIAL_KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Ensure a scope string is prefixed with `@`.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope prefixed with `@`
 * @throws Error if scope is empty
 */
export function normalizeScope(scope: string): string {
  if (!scope) throw new Error("Scope cannot be empty");
  return scope.startsWith("@") ? scope : `@${scope}`;
}

/**
 * Remove the leading `@` from a scope string.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope without the `@` prefix
 */
export function stripScope(scope: string): string {
  return scope.startsWith("@") ? scope.slice(1) : scope;
}

/** Parse "@scope/name" into { scope, name } or null if invalid.
 *  Both scope and name must be valid slugs (lowercase alphanumeric + hyphens). */
const SCOPED_NAME_REGEX = new RegExp(`^@(${SLUG_PATTERN})\\/(${SLUG_PATTERN})$`);

export function parseScopedName(scopedName: string): { scope: string; name: string } | null {
  const match = scopedName.match(SCOPED_NAME_REGEX);
  if (!match) return null;
  return { scope: match[1]!, name: match[3]! };
}

/** Single source of truth for package ownership. */
export function isOwnedByOrg(packageId: string, orgSlug: string): boolean {
  if (!orgSlug) return false;
  const parsed = parseScopedName(packageId);
  if (!parsed) return false;
  return parsed.scope === orgSlug;
}

/** Build a packageId from separated scope + name. */
export function buildPackageId(scope: string, name: string): string {
  const s = stripScope(scope);
  return `@${s}/${name}`;
}

/**
 * Encode a packageId ("@scope/name") into a URL path segment, keeping the
 * `@` and `/` separators literal so it matches route shapes such as:
 *   - `/:scope{(?:@|%40)...}/:name`      (single top-level package)
 *   - `/:packageId{@[^/]+/[^/]+}`        (routes that reference ≥2 packages)
 *
 * Naive `encodeURIComponent(packageId)` percent-encodes `/`→%2F, so the
 * scope/name split is lost. Use this canonical encoder instead of hand-rolling
 * — it is the one contract every consumer (frontend, SDK, github-action, MCP)
 * should import rather than re-discovering the footgun.
 *
 * Each segment is `encodeURIComponent`-encoded individually (defensive even
 * if `SLUG_PATTERN` ever loosens); the `@`/`/` separators stay literal.
 *
 * @throws Error if packageId is not a valid "@scope/name".
 */
export function encodePackageIdPath(packageId: string): string {
  const parsed = parseScopedName(packageId);
  if (!parsed) throw new Error(`Invalid packageId: ${packageId}`);
  return `@${encodeURIComponent(parsed.scope)}/${encodeURIComponent(parsed.name)}`;
}

/**
 * Convert an arbitrary human string into a URL-safe slug.
 * Lower-cases, strips diacritics, collapses non-[a-z0-9] runs into `-`
 * and trims leading/trailing dashes. Optional `maxLen` caps the result
 * (caller-side truncation of names like org slugs).
 *
 * Not the same as `SLUG_REGEX` — this accepts any input and produces a
 * valid slug; `SLUG_REGEX` validates that an already-formed string is
 * one. Callers that need validation should compose: `toSlug(x)` then
 * `SLUG_REGEX.test(result)`.
 */
export function toSlug(value: string, maxLen?: number): string {
  const out = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return maxLen && maxLen > 0 ? out.slice(0, maxLen) : out;
}

/**
 * MCP tool name validation.
 *
 * Format: `{namespace_snake}__{tool_snake}` \u2014 two snake_case tokens
 * joined by a double underscore. Hard length ceiling 56 chars leaves
 * headroom under the 64-char OpenAI/Anthropic limit for downstream
 * host re-prefixing (e.g. some CLI hosts add their own
 * `mcp__plugin_<plugin>_<server>__<tool>` super-prefix).
 */
export const TOOL_NAME_MAX_LEN = MCP_TOOL_NAME_MAX_LENGTH;
/**
 * Inner-token snake_case pattern shared by both halves of the namespaced MCP
 * tool name. Exposed so consumers that validate a *single* tool name (e.g.
 * `agentManifestSchema`'s `integrations[id].tools[]` — the agent
 * picks bare tool names, not pre-namespaced ones) match the same alphabet as
 * `TOOL_NAME_PATTERN`. Forbids a leading underscore so validation.ts and
 * naming.ts agree: validation.ts used to accept `_internal` while
 * naming.ts rejected `_internal__foo`, leaving a manifest-vs-runtime drift.
 *
 * Same shape as {@link CREDENTIAL_KEY_RE} — aliased so the pattern lives once.
 */
export const TOOL_NAME_INNER_PATTERN = CREDENTIAL_KEY_RE;
// The namespace token derives from a package id whose scope may start with a
// digit (`SLUG_PATTERN` and the AFPS name pattern both allow `@1password/…`),
// so it admits a leading digit. The tool token keeps the stricter
// letter-leading alphabet of {@link TOOL_NAME_INNER_PATTERN}.
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_]*__[a-z][a-z0-9_]*$/;

export function isValidToolName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LEN) return false;
  return TOOL_NAME_PATTERN.test(name);
}

/**
 * Normalise a raw tool name into the canonical snake_case `__`-joined
 * form. Returns the input unchanged when it's already valid.
 *
 * Mapping rules:
 * - Hyphens \u2192 underscores.
 * - Single-underscore separator \u2192 double-underscore boundary (only when
 *   no `__` is already present).
 * - Mixed-case \u2192 lower-case.
 */
export function normalizeToolName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = raw.toLowerCase();
  out = out.replace(/[-]+/g, "_");
  // If there's no `__` boundary yet, promote the first single underscore.
  if (!out.includes("__")) {
    out = out.replace(/_/, "__");
  }
  return out.slice(0, TOOL_NAME_MAX_LEN);
}
