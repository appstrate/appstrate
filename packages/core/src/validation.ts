// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { SLUG_PATTERN } from "./naming.ts";
import {
  // TODO: rename to agentManifestSchema after @afps-spec/schema is republished
  flowManifestSchema as afpsAgentManifestSchema,
  skillManifestSchema as afpsSkillManifestSchema,
  toolManifestSchema as afpsToolManifestSchema,
  providerManifestSchema as afpsProviderManifestSchema,
  authModeEnum as afpsAuthModeEnum,
  setupGuide as afpsSetupGuide,
} from "@afps-spec/schema";

// ─────────────────────────────────────────────
// Base manifest schema — common fields for all package types
// ─────────────────────────────────────────────

/** Regex matching scoped package names in the format `@scope/package-name`. */
export const scopedNameRegex = new RegExp(`^@${SLUG_PATTERN}\\/${SLUG_PATTERN}$`);

/** Zod enum for the four supported AFPS package types. */
export const packageTypeEnum = z.enum(["agent", "skill", "tool", "provider"]);
/** Union type of supported package types: "agent" | "skill" | "tool" | "provider". */
export type PackageType = z.infer<typeof packageTypeEnum>;
/** Array of all valid package type strings. */
export const PACKAGE_TYPES = packageTypeEnum.options;

/** AFPS JSON Schema URLs by package type — for the `$schema` field in manifest.json. */
export const AFPS_SCHEMA_URLS: Record<PackageType, string> = {
  agent: "https://afps.appstrate.dev/schema/v1/agent.schema.json",
  skill: "https://afps.appstrate.dev/schema/v1/skill.schema.json",
  tool: "https://afps.appstrate.dev/schema/v1/tool.schema.json",
  provider: "https://afps.appstrate.dev/schema/v1/provider.schema.json",
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
      tools: z.record(z.string(), z.string()).optional(),
      providers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/** Inferred type from the base manifest schema. */
export type Manifest = z.infer<typeof manifestSchema>;

// ─────────────────────────────────────────────
// Agent manifest schema — extends AFPS with core enhancements
// ─────────────────────────────────────────────

/** Zod schema for agent manifests — extends AFPS with relaxed optional metadata for local drafts. */
export const agentManifestSchema = afpsAgentManifestSchema.extend({
  // Override type to "agent" (published @afps-spec/schema still uses "flow" literal).
  // TODO: remove this override after @afps-spec/schema is republished with "agent".
  type: z.literal("agent"),
  // All standard fields (name, version, schemaVersion, dependencies,
  // displayName, providersConfiguration, input/output/config, timeout) inherited from AFPS.
  // Override metadata fields with .catch(undefined) for tolerant local editing.
  // AFPS requires author (MUST) for publication; core relaxes it for local drafts.
  author: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
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

// ─────────────────────────────────────────────
// Tool manifest schema — extends AFPS with core enhancements
// ─────────────────────────────────────────────

/** Zod schema for tool manifests — extends AFPS with relaxed optional metadata. */
export const toolManifestSchema = afpsToolManifestSchema.extend({
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
});

/** Inferred type from the tool manifest schema. */
export type ToolManifest = z.infer<typeof toolManifestSchema>;

// ─────────────────────────────────────────────
// Provider manifest schema — extends AFPS (superRefine inherited)
// ─────────────────────────────────────────────

/** Auth mode union type derived from the AFPS Zod enum. */
export type AuthMode = z.infer<typeof afpsAuthModeEnum>;

const _setupGuideSchema = afpsSetupGuide;

/** Provider setup guide type derived from the Zod schema. */
export type ProviderSetupGuide = NonNullable<z.infer<typeof _setupGuideSchema>>;

/** Available scope entry for OAuth provider configuration. */
export interface AvailableScope {
  value: string;
  label: string;
}

/**
 * Zod schema for provider manifests — extends AFPS with relaxed optional metadata.
 * Uses `.safeExtend()` because AFPS provider schema has `.superRefine()` (Zod 4 restriction).
 */
export const providerManifestSchema = afpsProviderManifestSchema.safeExtend({
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
});

/** Inferred type from the provider manifest schema. */
export type ProviderManifest = z.infer<typeof providerManifestSchema>;

/** Resolved provider definition built from a raw manifest JSONB object. */
export interface ResolvedProviderDefinition {
  id: string;
  displayName: string;
  authMode: AuthMode | undefined;
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  defaultScopes: string[];
  scopeSeparator: string;
  pkceEnabled: boolean;
  tokenAuthMethod?: string;
  authorizationParams: Record<string, string>;
  tokenParams: Record<string, string>;
  credentialSchema?: Record<string, unknown>;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  authorizedUris?: string[];
  allowAllUris: boolean;
  availableScopes?: AvailableScope[];
  requestTokenUrl?: string;
  accessTokenUrl?: string;
  iconUrl?: string;
  categories: string[];
  docsUrl?: string;
}

/**
 * Build a fully resolved provider definition from a raw manifest JSONB object.
 * Reads from nested manifest structure (oauth2/oauth1/credentials sub-objects)
 * and produces a flat resolved type for runtime convenience.
 * Pure function — no DB, no side effects.
 * Used by both the provider API routes and the connect package.
 */
export function buildProviderDefinitionFromManifest(
  id: string,
  manifest: Record<string, unknown>,
): ResolvedProviderDefinition {
  const rawDef = (manifest.definition ?? {}) as Record<string, unknown>;
  const authMode = rawDef.authMode as AuthMode | undefined;

  // Read from nested sub-objects (may be undefined if not applicable for this auth mode)
  const oauth2 = rawDef.oauth2 as Record<string, unknown> | undefined;
  const oauth1 = rawDef.oauth1 as Record<string, unknown> | undefined;
  const credentials = rawDef.credentials as Record<string, unknown> | undefined;

  return {
    id,
    displayName: (manifest.displayName as string) ?? id,
    authMode,
    // OAuth2 fields (from definition.oauth2)
    authorizationUrl: oauth2?.authorizationUrl as string | undefined,
    tokenUrl: oauth2?.tokenUrl as string | undefined,
    refreshUrl: oauth2?.refreshUrl as string | undefined,
    defaultScopes: (oauth2?.defaultScopes as string[]) ?? [],
    scopeSeparator: (oauth2?.scopeSeparator as string) ?? " ",
    pkceEnabled: (oauth2?.pkceEnabled as boolean) ?? true,
    tokenAuthMethod: oauth2?.tokenAuthMethod as string | undefined,
    authorizationParams: (oauth2?.authorizationParams as Record<string, string>) ?? {},
    tokenParams: (oauth2?.tokenParams as Record<string, string>) ?? {},
    // OAuth1 fields (from definition.oauth1)
    requestTokenUrl: oauth1?.requestTokenUrl as string | undefined,
    accessTokenUrl: oauth1?.accessTokenUrl as string | undefined,
    // OAuth1 also uses authorizationUrl and authorizationParams (for user redirect)
    ...(authMode === "oauth1"
      ? {
          authorizationUrl: oauth1?.authorizationUrl as string | undefined,
          authorizationParams: (oauth1?.authorizationParams as Record<string, string>) ?? {},
        }
      : {}),
    // Credential fields (from definition.credentials)
    credentialSchema: credentials?.schema as Record<string, unknown> | undefined,
    credentialFieldName: credentials?.fieldName as string | undefined,
    // Transport fields (from definition level — cross-cutting, implementation-specific)
    credentialHeaderName: rawDef.credentialHeaderName as string | undefined,
    credentialHeaderPrefix: rawDef.credentialHeaderPrefix as string | undefined,
    // Transversal fields
    authorizedUris: (rawDef.authorizedUris as string[])?.length
      ? (rawDef.authorizedUris as string[])
      : undefined,
    allowAllUris: (rawDef.allowAllUris as boolean) ?? false,
    availableScopes: (rawDef.availableScopes as AvailableScope[])?.length
      ? (rawDef.availableScopes as AvailableScope[])
      : undefined,
    // Presentation fields
    iconUrl: manifest.iconUrl as string | undefined,
    categories: (manifest.categories as string[]) ?? [],
    docsUrl: manifest.docsUrl as string | undefined,
  };
}

/** JSON Schema object type used for admin credential schemas. */
export interface AdminCredentialSchema {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

/**
 * Generate default admin credential schema per auth mode.
 * Returns null for auth modes that don't need admin credentials (api_key, basic, custom).
 */
export function getDefaultAdminCredentialSchema(authMode: string): AdminCredentialSchema | null {
  switch (authMode) {
    case "oauth2":
      return {
        type: "object",
        properties: {
          clientId: { type: "string", description: "Client ID" },
          clientSecret: { type: "string", description: "Client Secret" },
        },
        required: ["clientId", "clientSecret"],
      };
    case "oauth1":
      return {
        type: "object",
        properties: {
          consumerKey: { type: "string", description: "Consumer Key" },
          consumerSecret: { type: "string", description: "Consumer Secret" },
        },
        required: ["consumerKey", "consumerSecret"],
      };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// Unified validateManifest — dispatches by type
// ─────────────────────────────────────────────

/** Result of manifest validation — either valid with parsed manifest, or invalid with error messages. */
export type ValidateManifestResult =
  | {
      valid: true;
      errors: [];
      manifest: Manifest | AgentManifest | SkillManifest | ToolManifest | ProviderManifest;
    }
  | { valid: false; errors: string[]; manifest?: undefined };

function parseWithSchema(
  schema:
    | typeof manifestSchema
    | typeof agentManifestSchema
    | typeof skillManifestSchema
    | typeof toolManifestSchema
    | typeof providerManifestSchema,
  raw: unknown,
): ValidateManifestResult {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { valid: true, errors: [], manifest: result.data };
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return { valid: false, errors };
}

/**
 * Validate a raw manifest object by dispatching to the appropriate type-specific schema.
 * Determines the schema from the `type` field (agent, skill, tool, provider) and validates accordingly.
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
          : type === "provider"
            ? providerManifestSchema
            : type === "tool"
              ? toolManifestSchema
              : manifestSchema;
    return parseWithSchema(schema, raw);
  }
  return { valid: false, errors: ["type: Required field is missing"] };
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

/** Result of tool source code validation with errors and warnings. */
export interface ToolSourceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function stripLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*$/gm, "");
}

function countParams(paramStr: string): number {
  const trimmed = paramStr.trim();
  if (trimmed === "") return 0;

  let depth = 0;
  let count = 1;
  for (const ch of trimmed) {
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
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

/**
 * Validate a tool's TypeScript source code for structural correctness.
 * Checks for export default, registerTool() call, non-empty tool name, and correct execute signature.
 * @param source - The TypeScript source code of the tool
 * @returns Validation result with errors (structural issues) and warnings (best-practice suggestions)
 */
export function validateToolSource(source: string): ToolSourceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (source.trim().length === 0) {
    return { valid: false, errors: ["Tool content is empty"], warnings };
  }

  if (!/export\s+default\b/.test(source)) {
    errors.push(
      "Tool must have an `export default function`. " +
        "Example: export default function(pi: ToolAPI) { ... }",
    );
  }

  if (!/\.registerTool\s*\(/.test(source)) {
    warnings.push(
      "Tool does not call `pi.registerTool()`. " + "Make sure to register at least one tool.",
    );
  }

  // Check for empty tool name in registerTool({ name: "" })
  if (/registerTool\s*\(\s*\{[^}]{0,200}name\s*:\s*["']\s*["']/.test(source)) {
    errors.push(
      "Tool `name` must not be empty in `registerTool()`. " +
        'Example: pi.registerTool({ name: "my_tool", ... })',
    );
  }

  const cleaned = stripLineComments(source);
  const executeMatches = [...cleaned.matchAll(/execute\s*\(([^)]*)\)/g)];
  for (const match of executeMatches) {
    const paramStr = match[1]!;
    const paramCount = countParams(paramStr);
    if (paramCount === 1) {
      errors.push(
        "The `execute` signature has only one parameter. " +
          "The Pi SDK calls execute(toolCallId, params, signal) — with a single parameter, " +
          "your function will receive the toolCallId (string) instead of params. " +
          "Fix: execute(_toolCallId, params, signal) { ... }",
      );
      break;
    }
  }

  if (executeMatches.length > 0 && !/content\s*:/.test(cleaned)) {
    warnings.push(
      "The `execute` function does not seem to return `{ content: [...] }`. " +
        'Expected format: { content: [{ type: "text", text: "..." }] }',
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
