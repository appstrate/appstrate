// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { SLUG_PATTERN } from "./naming.ts";
import {
  agentManifestSchema as afpsAgentManifestSchema,
  skillManifestSchema as afpsSkillManifestSchema,
  tokenEndpointAuthMethodEnum as afpsTokenEndpointAuthMethodEnum,
} from "@afps-spec/schema";
import { integrationManifestSchema, type IntegrationManifest } from "./integration.ts";
import { mcpServerManifestSchema, type McpServerManifest } from "./mcp-server.ts";
import { SELECTABLE_RUNTIME_TOOLS } from "./runtime-tools-catalog.ts";

export { integrationManifestSchema, type IntegrationManifest };
export { mcpServerManifestSchema, type McpServerManifest };

// ─────────────────────────────────────────────
// Base manifest schema — common fields for all package types
// ─────────────────────────────────────────────

/** Regex matching scoped package names in the format `@scope/package-name`. */
export const scopedNameRegex = new RegExp(`^@${SLUG_PATTERN}\\/${SLUG_PATTERN}$`);

/** Zod enum for supported AFPS 2.0 package types (`tool`/`provider` removed; `mcp-server` added). */
export const packageTypeEnum = z.enum(["agent", "skill", "mcp-server", "integration"]);
/** Union type of supported package types. */
export type PackageType = z.infer<typeof packageTypeEnum>;
/** Array of all valid package type strings. */
export const PACKAGE_TYPES = packageTypeEnum.options;

/** AFPS JSON Schema URLs by package type — for the `$schema` field in manifest.json. */
export const AFPS_SCHEMA_URLS: Record<PackageType, string> = {
  agent: "https://afps.appstrate.dev/packages/schema/v2/agent.schema.json",
  skill: "https://afps.appstrate.dev/packages/schema/v2/skill.schema.json",
  "mcp-server": "https://afps.appstrate.dev/packages/schema/v2/mcp-server.schema.json",
  integration: "https://afps.appstrate.dev/packages/schema/v2/integration.schema.json",
};

/** Base Zod schema for package manifests — common fields shared by all package types (AFPS 2.0 snake_case). */
export const manifestSchema = z.looseObject({
  name: z.string().regex(scopedNameRegex, { error: "Must follow the format @scope/package-name" }),
  version: z.string().min(1),
  type: packageTypeEnum,
  display_name: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  dependencies: z
    .looseObject({
      skills: z.record(z.string(), z.string()).optional(),
      mcp_servers: z.record(z.string(), z.string()).optional(),
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
  // All standard fields (name, version, schema_version, dependencies,
  // display_name, input/output/config, timeout, integrations_configuration)
  // inherited from the AFPS 2.0 schema.
  // AFPS requires author (MUST) for publication; core relaxes it for local drafts.
  author: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  // Keys must be scoped package names; values are bare semver ranges
  // (npm-style). AFPS 2.0 dependency surface — `mcp_servers` replaces the
  // removed `tools` package references.
  dependencies: z
    .looseObject({
      skills: z.record(z.string().regex(scopedNameRegex), z.string()).optional(),
      mcp_servers: z.record(z.string().regex(scopedNameRegex), z.string()).optional(),
      integrations: z.record(z.string().regex(scopedNameRegex), z.string()).optional(),
    })
    .optional(),
  // First-party runtime tools enabled for this agent — all opt-in, none
  // auto-injected (`output` included). `output` is required to be present
  // only when an output schema is declared (enforced by the superRefine
  // below). Snake_case `runtime_tools` (was 1.x `runtimeTools`). This is an
  // Appstrate manifest extension with no AFPS equivalent — kept as a
  // documented top-level snake_case field rather than namespaced under
  // `_meta`, because it is woven through the run pipeline (catalog
  // validation, prompt builder, sidecar tool registration) and namespacing
  // it would be disproportionate.
  runtime_tools: z.array(z.enum(SELECTABLE_RUNTIME_TOOLS)).optional(),
  // Niveau 2 — per-integration runtime policy, folded into AFPS 2.0
  // `integrations_configuration` (§4.4). Keys mirror
  // `dependencies.integrations[id]`. `scopes[]` is the AFPS-defined key
  // (the explicit OAuth scope escape hatch, unioned with the set inferred
  // from the selected tools' `required_scopes`). `tools[]` is the
  // Appstrate-specific allowlist exposed to the agent's LLM via the
  // sidecar's McpHost — an extension key on the otherwise loose
  // `integration_configuration` object (AFPS `integrations_configuration`
  // values are looseObjects, so the extra key round-trips per §10).
  integrations_configuration: z
    .record(
      z.string().regex(scopedNameRegex),
      z.looseObject({
        scopes: z.array(z.string()).optional(),
        tools: z
          .array(
            z.string().regex(/^[a-z_][a-z0-9_]*$/, {
              error: "integration tool names must match /^[a-z_][a-z0-9_]*$/",
            }),
          )
          .optional(),
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

  const runtimeTools = (m as { runtime_tools?: unknown }).runtime_tools;
  const selectsOutput = Array.isArray(runtimeTools) && runtimeTools.includes("output");
  if (!selectsOutput) {
    ctx.addIssue({
      code: "custom",
      path: ["runtime_tools"],
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
 * OAuth2 token-endpoint client-authentication method (AFPS 2.0 §7.3,
 * `token_endpoint_auth_method`). Derived from the canonical Zod enum so
 * appstrate cannot drift. Consumed by `@appstrate/connect` token refresh /
 * exchange for OAuth model providers + integrations.
 */
export type OAuthTokenAuthMethod = z.infer<typeof afpsTokenEndpointAuthMethodEnum>;

// ─────────────────────────────────────────────
// Unified validateManifest — dispatches by type
// ─────────────────────────────────────────────

/** Result of manifest validation — either valid with parsed manifest, or invalid with error messages. */
export type ValidateManifestResult =
  | {
      valid: true;
      errors: [];
      manifest: Manifest | AgentManifest | SkillManifest | IntegrationManifest | McpServerManifest;
    }
  | { valid: false; errors: string[]; manifest?: undefined };

function parseWithSchema(
  schema:
    | typeof manifestSchema
    | typeof agentManifestSchema
    | typeof skillManifestSchema
    | typeof integrationManifestSchema
    | typeof mcpServerManifestSchema,
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
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // An mcp-server manifest is a verbatim MCPB manifest: it carries no
    // top-level AFPS `type`, declaring `type: "mcp-server"` under
    // `_meta["dev.afps/mcp-server"]` instead (AFPS §3.4). Detect it via that
    // identity (or an explicit top-level `type: "mcp-server"` if a consumer
    // annotates it).
    const meta = obj._meta as Record<string, unknown> | undefined;
    const afpsMcp = meta?.["dev.afps/mcp-server"] as { type?: unknown } | undefined;
    if (obj.type === "mcp-server" || afpsMcp?.type === "mcp-server") {
      return parseWithSchema(mcpServerManifestSchema, raw);
    }

    if ("type" in obj) {
      const type = obj.type;
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
  /** Maps from the AFPS 2.0 `display_name` manifest field. */
  displayName?: string;
}

/** Extract optional metadata fields from a manifest.
 *  Maps `repository` to `repositoryUrl` and AFPS 2.0 `display_name` to the
 *  `displayName` DB column convention. */
export function extractManifestMetadata(manifest: Partial<Manifest>): ManifestMetadata {
  const metadata: ManifestMetadata = {};
  if (manifest.description !== undefined) metadata.description = manifest.description;
  if (manifest.keywords !== undefined) metadata.keywords = manifest.keywords;
  if (manifest.license !== undefined) metadata.license = manifest.license;
  if (manifest.repository !== undefined) metadata.repositoryUrl = manifest.repository;
  if (manifest.display_name !== undefined) metadata.displayName = manifest.display_name;
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
