// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { SLUG_PATTERN, TOOL_NAME_INNER_PATTERN } from "./naming.ts";
import {
  agentManifestSchema as afpsAgentManifestSchema,
  skillManifestSchema as afpsSkillManifestSchema,
  tokenEndpointAuthMethodEnum as afpsTokenEndpointAuthMethodEnum,
  dependenciesSchema as afpsDependenciesSchema,
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

// ── AFPS 2.0 v2 common-field shapes (§3.1) ──
// Locally redeclared (not exported from `@afps-spec/schema`) because the
// canonical `commonFields` is an internal closure inside `createSchemas`.
// Shape MUST stay byte-compatible with the spec's `authorObject` /
// `repositoryObject` / `iconObject` / `compatibilityObject` — any divergence
// is a v2.0 conformance gap.

/** MCPB/npm-aligned author object (§3.1). */
const authorObjectSchema = z.looseObject({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});
/** `author` accepts a bare string OR a structured object (§3.1). */
const authorFieldSchema = z.union([z.string().min(1), authorObjectSchema]);

/** MCPB/npm-aligned repository object (§3.1). */
const repositoryObjectSchema = z.looseObject({
  type: z.string().min(1),
  url: z.string().min(1),
  directory: z.string().optional(),
});
/** `repository` accepts a bare string OR a structured object (§3.1). */
const repositoryFieldSchema = z.union([z.string().min(1), repositoryObjectSchema]);

/** Icon variant (MCPB-aligned, §3.1). `size` is `WIDTHxHEIGHT`. */
const iconObjectSchema = z.looseObject({
  src: z.string().min(1),
  size: z
    .string()
    .regex(/^\d+x\d+$/, { error: 'size must be "WIDTHxHEIGHT", e.g. "128x128"' })
    .optional(),
  theme: z.enum(["light", "dark", "high-contrast"]).optional(),
});

/** Compatibility (MCPB-aligned, §3.1). */
const compatibilityObjectSchema = z.looseObject({
  platforms: z.array(z.enum(["darwin", "win32", "linux"])).optional(),
  runtimes: z.record(z.string(), z.string()).optional(),
  clients: z.record(z.string(), z.string()).optional(),
});

/**
 * `_meta` reverse-DNS extension namespace (§10). The AFPS spec defines this
 * as a record of reverse-DNS-namespaced keys carrying opaque payloads — kept
 * permissive (consumers MUST NOT reject unknown `_meta` keys).
 */
const metaSchema = z.record(z.string(), z.unknown());

/** Base Zod schema for package manifests — common fields shared by all package types (AFPS 2.0 snake_case). */
export const manifestSchema = z.looseObject({
  name: z.string().regex(scopedNameRegex, { error: "Must follow the format @scope/package-name" }),
  version: z.string().min(1),
  type: packageTypeEnum,
  schema_version: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  long_description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  author: authorFieldSchema.optional(),
  repository: repositoryFieldSchema.optional(),
  homepage: z.string().optional(),
  documentation: z.string().optional(),
  support: z.string().optional(),
  icon: z.string().optional(),
  icons: z.array(iconObjectSchema).optional(),
  screenshots: z.array(z.string()).optional(),
  privacy_policies: z.array(z.string()).optional(),
  compatibility: compatibilityObjectSchema.optional(),
  // Polymorphic dependency map per AFPS 2.0.2 §4.1: each value is either a
  // bare semver range (string) OR an object `{ version, ... }` carrying
  // per-dependency configuration (e.g. `scopes`/`auth_key` for integrations).
  // Schema is re-used from the canonical `@afps-spec/schema` package to keep
  // appstrate from drifting.
  dependencies: afpsDependenciesSchema,
  _meta: metaSchema.optional(),
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
  // AFPS requires author (MUST, non-empty) for publication; core relaxes it
  // for local drafts (the agent-editor stores `author: ""` until the user
  // fills it in). Accepts both the AFPS 2.0 §3.1 structured-object form and
  // the legacy bare string (including the empty-string draft sentinel).
  author: z.union([z.string(), authorObjectSchema]).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  // Mirror the AFPS canonical: `repository` accepts string OR `{ type, url, directory? }`.
  repository: repositoryFieldSchema.optional(),
  // `dependencies` is inherited verbatim from the canonical AFPS
  // `agentManifestSchema`. Per §4.1 each value is polymorphic — a bare
  // semver range string OR an object `{ version, scopes?, auth_key?, ... }`.
  // We do not override the field here to avoid drifting from the spec.
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
            z.string().regex(TOOL_NAME_INNER_PATTERN, {
              error: "integration tool names must match /^[a-z][a-z0-9_]*$/",
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
  // Mirror the AFPS canonical: `repository` accepts string OR `{ type, url, directory? }`.
  repository: repositoryFieldSchema.optional(),
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
 *
 * Default-when-missing semantics (AFPS 2.0.1 / CHANGELOG, CC-10): when a
 * manifest omits `token_endpoint_auth_method`, callers default to
 * `"client_secret_basic"` — the RFC 8414 §2 / RFC 7591 §2 default. AFPS
 * 2.0.0 documented `"client_secret_post"` as the default; the flip
 * aligns with the wider OAuth 2.1 ecosystem (Anthropic, Google, GitHub,
 * Slack all accept Basic; some IdPs require it). Manifest-explicit
 * values continue to work unchanged.
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
    // AFPS 2.0.2 (§3.4 / §11.2): mcp-server identity was lifted from
    // `_meta["dev.afps/mcp-server"]` to the manifest root. `type: "mcp-server"`,
    // `name`, `schema_version`, and `dependencies` now live at the root; the
    // `_meta["dev.afps/mcp-server"]` block was removed entirely. Dispatch
    // purely on the root `type` discriminator.
    if (obj.type === "mcp-server") {
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

/**
 * Structured author shape (AFPS 2.0 §3.1) — the object form of the `author`
 * field. Mirrors the canonical AFPS schema; the field also accepts a bare
 * string. DB consumers store the original shape verbatim (no string→object
 * coercion) to round-trip publisher intent.
 */
export interface ManifestAuthorObject {
  name: string;
  email?: string;
  url?: string;
}

/**
 * Structured repository shape (AFPS 2.0 §3.1) — npm-aligned object form.
 * The legacy bare-string form maps to `repositoryUrl` for back-compat;
 * publishers using the object form get both `repositoryUrl` (mirrors
 * `repository.url`) and `repository` (full object).
 */
export interface ManifestRepositoryObject {
  type: string;
  url: string;
  directory?: string;
}

/** Icon variant (MCPB-aligned, §3.1). */
export interface ManifestIcon {
  src: string;
  size?: string;
  theme?: "light" | "dark" | "high-contrast";
}

/** Compatibility (MCPB-aligned, §3.1). */
export interface ManifestCompatibility {
  platforms?: Array<"darwin" | "win32" | "linux">;
  runtimes?: Record<string, string>;
  clients?: Record<string, string>;
}

/** Optional metadata fields extracted from a manifest, with DB column naming conventions. */
export interface ManifestMetadata {
  description?: string;
  longDescription?: string;
  keywords?: string[];
  license?: string;
  /**
   * Maps from manifest `repository` field to DB `repositoryUrl` column.
   * For the bare-string form, this is the string verbatim. For the object
   * form (§3.1), this mirrors `repository.url` so a single DB column keeps
   * pointing at the canonical URL.
   */
  repositoryUrl?: string;
  /** Structured object form of `repository` when the publisher emitted one (§3.1). */
  repository?: ManifestRepositoryObject;
  /** Maps from the AFPS 2.0 `display_name` manifest field. */
  displayName?: string;
  /**
   * Author — preserved in whichever form the manifest declares. Bare strings
   * round-trip as strings; object form round-trips as the structured shape.
   * Consumers projecting to a single DB column SHOULD fold `string → { name: string }`.
   */
  author?: string | ManifestAuthorObject;
  homepage?: string;
  documentation?: string;
  /** Support / issue-tracker URL (analogous to npm `bugs.url`) per §3.1. */
  support?: string;
  /** Primary icon URL (§3.1). For the structured catalog use `icons`. */
  icon?: string;
  icons?: ManifestIcon[];
  screenshots?: string[];
  privacyPolicies?: string[];
  compatibility?: ManifestCompatibility;
}

/** Extract optional metadata fields from a manifest.
 *  Maps `repository` to `repositoryUrl` and AFPS 2.0 `display_name` to the
 *  `displayName` DB column convention. Both bare-string and structured object
 *  forms of `author` / `repository` round-trip per §3.1. */
export function extractManifestMetadata(manifest: Partial<Manifest>): ManifestMetadata {
  const metadata: ManifestMetadata = {};
  if (manifest.description !== undefined) metadata.description = manifest.description;
  if (manifest.long_description !== undefined) metadata.longDescription = manifest.long_description;
  if (manifest.keywords !== undefined) metadata.keywords = manifest.keywords;
  if (manifest.license !== undefined) metadata.license = manifest.license;
  if (manifest.repository !== undefined) {
    if (typeof manifest.repository === "string") {
      metadata.repositoryUrl = manifest.repository;
    } else {
      const repo = manifest.repository as ManifestRepositoryObject;
      metadata.repository = repo;
      metadata.repositoryUrl = repo.url;
    }
  }
  if (manifest.display_name !== undefined) metadata.displayName = manifest.display_name;
  if (manifest.author !== undefined) {
    metadata.author =
      typeof manifest.author === "string"
        ? manifest.author
        : (manifest.author as ManifestAuthorObject);
  }
  if (manifest.homepage !== undefined) metadata.homepage = manifest.homepage;
  if (manifest.documentation !== undefined) metadata.documentation = manifest.documentation;
  if (manifest.support !== undefined && typeof manifest.support === "string") {
    metadata.support = manifest.support;
  }
  if (manifest.icon !== undefined) metadata.icon = manifest.icon;
  if (manifest.icons !== undefined) metadata.icons = manifest.icons as ManifestIcon[];
  if (manifest.screenshots !== undefined) metadata.screenshots = manifest.screenshots;
  if (manifest.privacy_policies !== undefined) metadata.privacyPolicies = manifest.privacy_policies;
  if (manifest.compatibility !== undefined)
    metadata.compatibility = manifest.compatibility as ManifestCompatibility;
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
 * Works for both skills and integrations. The dep value type is left
 * open (`unknown`) to accept both the bare-string and AFPS 2.0.2 §4.1
 * object forms — only the keys are read.
 */
export function findMissingDependencies(
  required: Record<string, unknown>,
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  return Object.keys(required).filter((id) => !installed.has(id));
}
