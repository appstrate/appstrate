// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { SLUG_PATTERN } from "./naming.ts";
import {
  agentManifestSchema as afpsAgentManifestSchema,
  skillManifestSchema as afpsSkillManifestSchema,
  oauthTokenAuthMethodEnum as afpsOAuthTokenAuthMethodEnum,
  oauthTokenContentTypeEnum as afpsOAuthTokenContentTypeEnum,
} from "@afps-spec/schema";
import { integrationManifestSchema, type IntegrationManifest } from "./integration.ts";
import { SELECTABLE_RUNTIME_TOOLS } from "./runtime-tools-catalog.ts";

export { integrationManifestSchema, type IntegrationManifest };

// ─────────────────────────────────────────────
// Base manifest schema — common fields for all package types
// ─────────────────────────────────────────────

/** Regex matching scoped package names in the format `@scope/package-name`. */
export const scopedNameRegex = new RegExp(`^@${SLUG_PATTERN}\\/${SLUG_PATTERN}$`);

/** Zod enum for supported AFPS package types (Phase 1.0 adds `integration`). */
export const packageTypeEnum = z.enum(["agent", "skill", "integration"]);
/** Union type of supported package types. */
export type PackageType = z.infer<typeof packageTypeEnum>;
/** Array of all valid package type strings. */
export const PACKAGE_TYPES = packageTypeEnum.options;

/** AFPS JSON Schema URLs by package type — for the `$schema` field in manifest.json. */
export const AFPS_SCHEMA_URLS: Record<PackageType, string> = {
  agent: "https://afps.appstrate.dev/packages/schema/v1/agent.schema.json",
  skill: "https://afps.appstrate.dev/packages/schema/v1/skill.schema.json",
  integration: "https://afps.appstrate.dev/packages/schema/v1/integration.schema.json",
};

/** Base Zod schema for package manifests — common fields shared by all package types. */
export const manifestSchema = z.looseObject({
  name: z.string().regex(scopedNameRegex, { error: "Must follow the format @scope/package-name" }),
  version: z.string().min(1),
  type: packageTypeEnum,
  displayName: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  dependencies: z
    .looseObject({
      skills: z.record(z.string(), z.string()).optional(),
      // Bare semver ranges (npm-style), same shape as the canonical
      // agentManifestSchema. Per-integration tool/scope selection lives in
      // the top-level `integrations` block, not in `dependencies`.
      integrations: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/** Inferred type from the base manifest schema. */
export type Manifest = z.infer<typeof manifestSchema>;

// ─────────────────────────────────────────────
// Agent manifest schema — extends AFPS with core enhancements
// ─────────────────────────────────────────────

/**
 * Zod schema for agent manifests — extends AFPS with relaxed optional metadata for local drafts
 * AND the Phase 1.0 `dependencies.integrations` map (proposal §4.2.3).
 */
const agentManifestObjectSchema = afpsAgentManifestSchema.extend({
  // All standard fields (name, version, schemaVersion, dependencies,
  // displayName, input/output/config, timeout) inherited from AFPS.
  // Override metadata fields with .catch(undefined) for tolerant local editing.
  // AFPS requires author (MUST) for publication; core relaxes it for local drafts.
  author: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  // Keys must be scoped package names; values are bare semver ranges
  // (npm-style). Per-integration tool/scope selection lives in the
  // top-level `integrations` field below, so `dependencies` stays a pure
  // version-resolution surface.
  dependencies: z
    .looseObject({
      skills: z.record(z.string().regex(scopedNameRegex), z.string()).optional(),
      integrations: z.record(z.string().regex(scopedNameRegex), z.string()).optional(),
    })
    .optional(),
  // First-party runtime tools enabled for this agent — all opt-in, none
  // auto-injected (`output` included). `output` is required to be present
  // only when an output schema is declared (enforced by the superRefine
  // below). Replaces the former `dependencies.tools` package references
  // (the `tool` package type was removed — these tools are baked into the
  // runtime image).
  runtimeTools: z.array(z.enum(SELECTABLE_RUNTIME_TOOLS)).optional(),
  // Niveau 2 — per-integration runtime policy. Keys mirror
  // `dependencies.integrations[id]`. `tools[]` is the allowlist exposed
  // to the agent's LLM via the sidecar's McpHost (Phase 3); empty or
  // missing means the integration is declared but no tools are used
  // (= no MCP surface, no auth required at run kickoff). `scopes[]` is
  // an explicit OAuth scope escape hatch unioned with the set inferred
  // from the selected tools' `requiredScopes`.
  integrations: z
    .record(
      z.string().regex(scopedNameRegex),
      z.object({
        tools: z
          .array(
            z.string().regex(/^[a-z_][a-z0-9_]*$/, {
              error: "integration tool names must match /^[a-z_][a-z0-9_]*$/",
            }),
          )
          .optional(),
        scopes: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/**
 * `output` is opt-in like every runtime tool (none is auto-injected). But an
 * agent that declares an `output.schema` promises a typed result, so it MUST
 * enable the `output` tool — otherwise it has no way to emit that result and
 * the run would fail post-hoc output validation. Caught at save/install time
 * here so the editor surfaces it on the `runtimeTools` field. Agents with no
 * output schema may finish without ever calling output (side-effect-only run).
 */
export const agentManifestSchema = agentManifestObjectSchema.superRefine((m, ctx) => {
  const outputSchema = (m as { output?: { schema?: unknown } }).output?.schema;
  const hasOutputSchema =
    outputSchema != null &&
    typeof outputSchema === "object" &&
    Object.keys(outputSchema as object).length > 0;
  if (!hasOutputSchema) return;

  const runtimeTools = (m as { runtimeTools?: unknown }).runtimeTools;
  const selectsOutput = Array.isArray(runtimeTools) && runtimeTools.includes("output");
  if (!selectsOutput) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeTools"],
      message:
        "The 'output' runtime tool must be enabled when an output schema is defined — " +
        "an agent that declares an output schema must be able to return its result.",
    });
  }
});

/** Inferred type from the agent manifest schema. */
export type AgentManifest = z.infer<typeof agentManifestSchema>;

// ─────────────────────────────────────────────
// Skill manifest schema — extends AFPS with core enhancements
// ─────────────────────────────────────────────

/** Zod schema for skill manifests — extends AFPS with relaxed optional metadata. */
export const skillManifestSchema = afpsSkillManifestSchema.extend({
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
});

/** Inferred type from the skill manifest schema. */
export type SkillManifest = z.infer<typeof skillManifestSchema>;

/** Available scope entry for OAuth configuration. */
export interface AvailableScope {
  value: string;
  label: string;
}

/**
 * OAuth2 token-endpoint auth method and `tokenContentType` are part of
 * AFPS v1 (§7.2). Types are derived from the canonical Zod enums so
 * appstrate cannot drift. Consumed by `@appstrate/connect` token refresh /
 * exchange for OAuth model providers + integrations.
 */
export type OAuthTokenAuthMethod = z.infer<typeof afpsOAuthTokenAuthMethodEnum>;
export type OAuthTokenContentType = z.infer<typeof afpsOAuthTokenContentTypeEnum>;

// ─────────────────────────────────────────────
// Unified validateManifest — dispatches by type
// ─────────────────────────────────────────────

/** Result of manifest validation — either valid with parsed manifest, or invalid with error messages. */
export type ValidateManifestResult =
  | {
      valid: true;
      errors: [];
      manifest: Manifest | AgentManifest | SkillManifest | IntegrationManifest;
    }
  | { valid: false; errors: string[]; manifest?: undefined };

function parseWithSchema(
  schema:
    | typeof manifestSchema
    | typeof agentManifestSchema
    | typeof skillManifestSchema
    | typeof integrationManifestSchema,
  raw: unknown,
): ValidateManifestResult {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { valid: false, errors };
  }

  return { valid: true, errors: [], manifest: result.data };
}

/**
 * Validate a raw manifest object by dispatching to the appropriate type-specific schema.
 * Determines the schema from the `type` field (agent, skill, integration) and validates accordingly.
 * @param raw - The raw manifest object to validate (typically parsed from JSON)
 * @returns Validation result with parsed manifest on success, or error messages on failure
 */
export function validateManifest(raw: unknown): ValidateManifestResult {
  if (raw && typeof raw === "object" && "type" in raw) {
    const type = (raw as Record<string, unknown>).type;
    const schema =
      type === "agent"
        ? agentManifestSchema
        : type === "skill"
          ? skillManifestSchema
          : type === "integration"
            ? integrationManifestSchema
            : manifestSchema;
    return parseWithSchema(schema, raw);
  }
  // No `type` field — run the base schema so every missing-field error is
  // surfaced in a single pass (instead of short-circuiting on `type` alone).
  return parseWithSchema(manifestSchema, raw);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract name and description from a SKILL.md file's YAML frontmatter.
 * @param content - The full text content of a SKILL.md file
 * @returns Extracted name, description, and any parsing warnings
 */
export function extractSkillMeta(content: string): {
  name: string;
  description: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const fmMatch = content.match(/^---[^\S\n]*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    warnings.push("No YAML frontmatter detected (expected --- ... --- block)");
    return { name: "", description: "", warnings };
  }

  const fm = fmMatch[1]!;
  const nameMatch = fm.match(/name:[ \t]*(.+)/);
  const descMatch = fm.match(/description:[ \t]*(.+)/);

  const name = nameMatch ? stripQuotes(nameMatch[1]!) : "";
  const description = descMatch ? stripQuotes(descMatch[1]!) : "";

  if (!name) {
    warnings.push("Missing 'name' field in YAML frontmatter");
  }
  if (!description) {
    warnings.push("Missing 'description' field in YAML frontmatter");
  }

  return { name, description, warnings };
}

/** Optional metadata fields extracted from a manifest, with DB column naming conventions. */
export interface ManifestMetadata {
  description?: string;
  keywords?: string[];
  license?: string;
  /** Maps from manifest `repository` field to DB `repositoryUrl` column. */
  repositoryUrl?: string;
  displayName?: string;
}

/** Extract optional metadata fields from a manifest.
 *  Maps `repository` to `repositoryUrl` to match the DB column convention. */
export function extractManifestMetadata(manifest: Partial<Manifest>): ManifestMetadata {
  const metadata: ManifestMetadata = {};
  if (manifest.description !== undefined) metadata.description = manifest.description;
  if (manifest.keywords !== undefined) metadata.keywords = manifest.keywords;
  if (manifest.license !== undefined) metadata.license = manifest.license;
  if (manifest.repository !== undefined) metadata.repositoryUrl = manifest.repository;
  if (manifest.displayName !== undefined) metadata.displayName = manifest.displayName;
  return metadata;
}

// ─────────────────────────────────────────────
// Agent readiness utilities
// ─────────────────────────────────────────────

/** Check if a prompt is empty or whitespace-only. */
export function isPromptEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

/**
 * Find IDs declared in `required` but missing from `installed`.
 * Works for both skills and integrations.
 */
export function findMissingDependencies(
  required: Record<string, string>,
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  return Object.keys(required).filter((id) => !installed.has(id));
}
