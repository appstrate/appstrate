// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  agentManifestObjectSchema as afpsAgentManifestObjectSchema,
  refineIntegrationsConfiguration,
  skillManifestSchema as afpsSkillManifestSchema,
  tokenEndpointAuthMethodEnum as afpsTokenEndpointAuthMethodEnum,
  dependenciesSchema as afpsDependenciesSchema,
  scopedName as afpsScopedName,
  packageTypeEnum as afpsPackageTypeEnum,
  metaSchema as afpsMetaSchema,
} from "@afps-spec/schema";
import { integrationManifestSchema, type IntegrationManifest } from "./integration.ts";
import { mcpServerManifestSchema, type McpServerManifest } from "./mcp-server.ts";
import { findRetiredDependencyKeys } from "./dependencies.ts";
import { parseSkillFrontmatter } from "@appstrate/afps-shared/companion-files";
import { asRecord } from "./safe-json.ts";
import { isAppearanceColor, type AppearanceColor } from "./appearance.ts";

export { integrationManifestSchema, type IntegrationManifest };
export { mcpServerManifestSchema, type McpServerManifest };

// ─────────────────────────────────────────────
// Base manifest schema — common fields for all package types
// ─────────────────────────────────────────────

/**
 * Regex matching scoped package names in the format `@scope/package-name`.
 * Derived from the canonical AFPS `scopedName` Zod schema at module-load time
 * so the regex source can never drift from the spec. The schema package
 * exposes `scopedName` (a Zod schema) but not the raw regex constant — we
 * extract it from the schema's internal regex check. Falls back to a
 * structurally-equivalent literal if the internal shape changes (defensive;
 * a unit test asserts the extraction stays sound).
 */
/**
 * Regex matching AFPS `schema_version` values (Appendix B): `MAJOR.MINOR` with
 * no leading zeros on either component. The canonical `schemaVersionField` in
 * `@afps-spec/schema` is parameterized by major version and lives as a closure
 * private inside `createSchemas` — it is not exported as a raw constant. We
 * inline the spec-mandated pattern here so the base manifest schema can enforce
 * it without binding to a specific major.
 */
export const SCHEMA_VERSION_REGEX: RegExp = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Highest AFPS `schema_version` MAJOR this build supports. Per spec §2.4,
 * consumers MUST reject manifests whose MAJOR exceeds the highest known
 * MAJOR — a forward-major manifest may carry breaking changes that this
 * build can't safely interpret. Higher MINOR within the same MAJOR is
 * best-effort accepted (additive-only per §2.4).
 */
export const SUPPORTED_SCHEMA_VERSION_MAJOR = 0 as const;

/**
 * The AFPS `schema_version` every manifest this platform writes declares — the
 * spec revision it conforms to (spec Appendix A: "producers MUST emit `0.3`").
 * Reading does not compare against it: any MINOR of
 * `SUPPORTED_SCHEMA_VERSION_MAJOR` is accepted, because published versions are
 * immutable and many were written at an earlier MINOR.
 */
export const AFPS_SCHEMA_VERSION = "0.3" as const;

export const scopedNameRegex: RegExp = (() => {
  // Zod 4 internal: scopedName._zod.def.checks[0]._zod.def.pattern : RegExp
  type ZodInternalCheck = { _zod?: { def?: { pattern?: RegExp } } };
  type ZodInternalSchema = { _zod?: { def?: { checks?: ZodInternalCheck[] } } };
  const internal = afpsScopedName as unknown as ZodInternalSchema;
  const pattern = internal._zod?.def?.checks?.[0]?._zod?.def?.pattern;
  if (pattern instanceof RegExp) return pattern;
  // Defensive fallback — keep validation working if Zod's internal shape changes.
  // Matches the canonical AFPS SCOPED_NAME_REGEX (spec.md §2.2 / schema package).
  return /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
})();

/** Zod enum for supported AFPS package types. Canonical export re-exposed from `@afps-spec/schema`. */
export const packageTypeEnum = afpsPackageTypeEnum;
/** Union type of supported package types. */
export type PackageType = z.infer<typeof packageTypeEnum>;

/** AFPS JSON Schema URLs by package type — for the `$schema` field in manifest.json. */
export const AFPS_SCHEMA_URLS: Record<PackageType, string> = {
  agent: "https://schemas.afps.dev/v0/agent.schema.json",
  skill: "https://schemas.afps.dev/v0/skill.schema.json",
  "mcp-server": "https://schemas.afps.dev/v0/mcp-server.schema.json",
  integration: "https://schemas.afps.dev/v0/integration.schema.json",
};

// ── AFPS common-field shapes (§3.1) ──
// TODO: Upstream these shapes to `@afps-spec/schema`. The canonical
// `commonFields` table (authorObject / repositoryObject / iconObject /
// compatibilityObject) lives inside `createSchemas` as a closure-private const;
// promoting them to named exports would let consumers like appstrate-core import
// them directly instead of redeclaring (drift risk). A parity snapshot test
// below pins these locals against the canonical agent manifest schema — any
// divergence breaks the suite.

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
 * AFPS Appendix B `META_NAMESPACE_KEY` regex — an OPTIONAL reverse-DNS namespace
 * prefix (lowercase, hyphenated, with at least one dot) followed by `/` then an
 * identifier (`[A-Za-z0-9._-]+`); a bare identifier with no `/` is also valid.
 *
 * Local copy that mirrors the AFPS 0.1 Appendix B pattern. The upstream
 * `@afps-spec/schema` package now exports its own `META_NAMESPACE_KEY_REGEX`,
 * but only from the schema module (not from the package entry point), so it
 * cannot be cleanly re-exported here. The upstream variant additionally folds
 * in the §10.1 reserved-prefix negative-lookahead; this local copy deliberately
 * OMITS that lookahead because its sole consumer
 * (`apps/api/src/services/integration-import-warnings.ts`) only emits
 * non-blocking import-time warnings — reserved-prefix keys are already
 * hard-rejected upstream at manifest-validation time and never reach the
 * warning path, so adding the lookahead here would not change behavior.
 */
export const META_NAMESPACE_KEY_REGEX: RegExp = /^([a-z0-9-]+(\.[a-z0-9-]+)+\/)?[A-Za-z0-9._-]+$/;

/**
 * `_meta` reverse-DNS extension namespace (§10). Delegates fully to the upstream
 * `@afps-spec/schema` `metaSchema`. As of AFPS 0.1 the upstream schema is STRICT:
 * it enforces the Appendix B `META_NAMESPACE_KEY` pattern AND rejects the
 * MCP-reserved `mcp/` / `modelcontextprotocol/` prefixes at parse time (the
 * pattern bakes in a reserved-prefix negative-lookahead). Well-formed unknown
 * namespaces are accepted (consumers MUST NOT reject them per §10.1); malformed
 * keys and reserved prefixes are hard-rejected (a malformed `_meta` key makes the
 * package malformed per §2). The earlier local soft-fail layer is gone — appstrate
 * does not own any `_meta` policy.
 */
export const metaSchema = afpsMetaSchema;

/** Base Zod schema for package manifests — common fields shared by all package types (AFPS snake_case). */
export const manifestSchema = z.looseObject({
  name: z.string().regex(scopedNameRegex, { error: "Must follow the format @scope/package-name" }),
  version: z.string().min(1),
  type: packageTypeEnum,
  schema_version: z
    .string()
    .regex(SCHEMA_VERSION_REGEX, {
      error: `schema_version must follow MAJOR.MINOR format with no leading zeros (e.g. "${AFPS_SCHEMA_VERSION}")`,
    })
    .refine(
      (v) => {
        const major = parseInt(v.split(".")[0]!, 10);
        return Number.isFinite(major) && major <= SUPPORTED_SCHEMA_VERSION_MAJOR;
      },
      {
        error: `schema_version MAJOR exceeds highest supported (${SUPPORTED_SCHEMA_VERSION_MAJOR}) — per AFPS §2.4, consumers MUST reject forward-major manifests`,
      },
    )
    .optional(),
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
  // Flat dependency maps per AFPS §4.1: each value is a bare semver range
  // string. Per-integration agent configuration lives in the top-level
  // `integrations_configuration` map (§4.4). Schema is re-used from the
  // canonical `@afps-spec/schema` package to keep appstrate from drifting.
  dependencies: afpsDependenciesSchema,
  _meta: metaSchema.optional(),
});

/** Inferred type from the base manifest schema. */
export type Manifest = z.infer<typeof manifestSchema>;

// ─────────────────────────────────────────────
// Agent manifest schema — extends AFPS with core enhancements
// ─────────────────────────────────────────────

/** Appstrate vendor-extension key for optional agent resource hints. */
export const AGENT_RESOURCES_META_KEY = "dev.appstrate/resources";

/** Appstrate vendor-extension key for an agent's presentation: `color`, read by Appstrate surfaces only. */
export const AGENT_UI_META_KEY = "dev.appstrate/ui";

/**
 * An agent's identity tile: the AFPS manifest `icon` (its grammar is
 * `@appstrate/core/appearance`; a picked icon is `lucide:<name>`), and the
 * `color` held under `_meta[AGENT_UI_META_KEY]`. Both are always present:
 * `icon` is any non-empty string, read leniently (a surface parses it), and
 * `color` a palette key — anything else, a `#rrggbb` included, reads as
 * `null`, i.e. derived from the agent id.
 */
export function readAgentAppearance(manifest: Record<string, unknown>): {
  icon: string | null;
  color: AppearanceColor | null;
} {
  const icon = typeof manifest.icon === "string" && manifest.icon !== "" ? manifest.icon : null;
  const ui = asRecord(asRecord(manifest._meta)[AGENT_UI_META_KEY]);
  return { icon, color: isAppearanceColor(ui.color) ? ui.color : null };
}

/**
 * Agent-authored resource hints read from `_meta["dev.appstrate/resources"]`.
 *
 * These values are requests, not entitlements. The platform resolves them
 * against deployment policy before launching a run.
 */
export interface AgentResourceHints {
  readonly memoryMb?: number;
  readonly cpu?: number;
}

const agentResourceHintsMetaSchema = z
  .strictObject({
    memory_mb: z
      .number({ error: "memory_mb must be a number" })
      .int({ error: "memory_mb must be a positive safe integer" })
      .positive({ error: "memory_mb must be a positive safe integer" })
      .optional(),
    cpu: z
      .number({ error: "cpu must be a number" })
      .int({ error: "cpu must be a positive safe integer" })
      .positive({ error: "cpu must be a positive safe integer" })
      .optional(),
  })
  .refine((hints) => hints.memory_mb !== undefined || hints.cpu !== undefined, {
    error: "At least one of memory_mb or cpu must be declared",
  });

function refineAgentResourceHints(metaValue: unknown, ctx: z.RefinementCtx): void {
  const result = agentResourceHintsMetaSchema.safeParse(metaValue);
  if (result.success) return;

  const basePath = ["_meta", AGENT_RESOURCES_META_KEY];
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        ctx.addIssue({
          code: "custom",
          path: [...basePath, key],
          message: `Unknown agent resource hint "${key}"`,
        });
      }
      continue;
    }
    ctx.addIssue({
      code: "custom",
      path: [...basePath, ...issue.path],
      message: issue.message,
    });
  }
}

/**
 * Zod schema for agent manifests — extends AFPS with relaxed optional metadata for local drafts
 * AND the `dependencies.integrations` map.
 */
const agentManifestObjectSchema = afpsAgentManifestObjectSchema.extend({
  // All standard fields (name, version, schema_version, dependencies,
  // display_name, input/output, timeout) inherited from the AFPS
  // schema.
  // AFPS requires author (MUST, non-empty) for publication; core relaxes it
  // for local drafts (the agent-editor stores `author: ""` until the user
  // fills it in). Accepts both the AFPS §3.1 structured-object form and
  // the bare-string form (including the empty-string draft sentinel).
  author: z.union([z.string(), authorObjectSchema]).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  // Mirror the AFPS canonical: `repository` accepts string OR `{ type, url, directory? }`.
  repository: repositoryFieldSchema.optional(),
  // `dependencies` and `integrations_configuration` are inherited verbatim
  // from the canonical AFPS `agentManifestSchema` (§4.1 flat semver-range
  // maps + §4.4 per-integration config, including the rule that every
  // `integrations_configuration` key matches a declared integration dep).
  // We do not override those fields here to avoid drifting from the spec.
  // The §4.4 `tools` wildcard (`string[] | "*"`) is supported by
  // the canonical schema as of @afps-spec/schema@0.5.0; no local widening is
  // needed — the inherited shape already matches the Appstrate runtime
  // contract (`dependencies.ts` `ToolsWildcard` / `isToolsWildcard`).
});

/**
 * The agent manifest schema: the AFPS base object plus the cross-field rules
 * Zod cannot express structurally (orphan integration configuration, resource
 * hints).
 */
export const agentManifestSchema = agentManifestObjectSchema.superRefine((m, ctx) => {
  // AFPS §4.4 — re-apply the canonical orphan-key rule (the base AFPS schema
  // is the plain object here so it stays extendable; the rule lives in the
  // shared `refineIntegrationsConfiguration` to avoid drift).
  refineIntegrationsConfiguration(m, ctx);

  const resourceHints = (m as { _meta?: Record<string, unknown> })._meta?.[
    AGENT_RESOURCES_META_KEY
  ];
  if (resourceHints !== undefined) {
    refineAgentResourceHints(resourceHints, ctx);
  }
});

/** Inferred type from the agent manifest schema. */
export type AgentManifest = z.infer<typeof agentManifestSchema>;

/**
 * Read the validated Appstrate resource-hint extension from an agent manifest.
 *
 * Returns `undefined` when the extension is absent. Malformed values throw:
 * callers should pass a manifest accepted by {@link agentManifestSchema}, so a
 * throw signals that validation was bypassed or stored data is corrupt.
 */
export function getAgentResourceHints(
  manifest: { readonly _meta?: Readonly<Record<string, unknown>> } | null | undefined,
): AgentResourceHints | undefined {
  const raw = manifest?._meta?.[AGENT_RESOURCES_META_KEY];
  if (raw === undefined) return undefined;

  const parsed = agentResourceHintsMetaSchema.parse(raw);
  return {
    ...(parsed.memory_mb !== undefined ? { memoryMb: parsed.memory_mb } : {}),
    ...(parsed.cpu !== undefined ? { cpu: parsed.cpu } : {}),
  };
}

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

/**
 * OAuth2 token-endpoint client-authentication method (AFPS §7.3,
 * `token_endpoint_auth_method`). Derived from the canonical Zod enum so
 * appstrate cannot drift. Consumed by `@appstrate/connect` token refresh /
 * exchange for OAuth model providers + integrations.
 *
 * Default-when-missing semantics (AFPS / CHANGELOG, CC-10): when a
 * manifest omits `token_endpoint_auth_method`, callers default to
 * `"client_secret_basic"` — the RFC 8414 §2 / RFC 7591 §2 default. An
 * earlier AFPS draft documented `"client_secret_post"` as the default; the flip
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
  | {
      valid: false;
      errors: string[];
      /**
       * The same failures, structured: `path` dotted, and `code` set on a rule that carries its
       * own. Absent on a dispatcher-level failure
       * (unknown type, retired keys), which only `errors` states.
       */
      issues?: ManifestIssue[];
      manifest?: undefined;
    };

/** One structured manifest validation failure. */
export interface ManifestIssue {
  path: string;
  message: string;
  code?: string;
}

function parseWithSchema(
  schema:
    | typeof manifestSchema
    | typeof agentManifestSchema
    | typeof skillManifestSchema
    | typeof integrationManifestSchema
    | typeof mcpServerManifestSchema,
  raw: unknown,
): ValidateManifestResult {
  // `_meta` validation is delegated entirely to the canonical per-type schema.
  // As of AFPS 0.1 the upstream `metaSchema` is STRICT — it enforces the
  // Appendix B `META_NAMESPACE_KEY` pattern and hard-rejects the reserved
  // `mcp/` / `modelcontextprotocol/` prefixes at parse time, so a malformed or
  // reserved `_meta` key already surfaces as a `safeParse` failure below.
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue): ManifestIssue => {
      const code = (issue as { params?: { code?: unknown } }).params?.code;
      return {
        path: issue.path.join("."),
        message: issue.message,
        ...(typeof code === "string" ? { code } : {}),
      };
    });
    const errors = issues.map((issue) => `${issue.path}: ${issue.message}`);
    return { valid: false, errors, issues };
  }

  return { valid: true, errors: [], manifest: result.data };
}

/**
 * How {@link validateManifest} treats the manifest vocabulary the platform
 * retired: the `dependencies` keys AFPS 2.0 retired — `tools` (replaced by
 * `mcp_servers`) and `providers` (replaced by `integrations`) — and the agent
 * field `runtime_tools` (replaced by the `@appstrate/platform` integration). The
 * one behaviour that MUST differ by direction:
 *
 *   - `"reject"` (default) — the manifest is AUTHOR INPUT (create, update,
 *     import, an inline manifest from an API client, a repo-authored system
 *     package). A retired key declares something no reader will ever honour,
 *     so the author must see it, with its replacement named.
 *   - `"tolerate"` — the manifest was ALREADY PERSISTED (a stored draft, a
 *     published version snapshot or archive). A retired key is TOLERATED, left
 *     exactly where it is: it is inert (no reader reads it), and rewriting a
 *     stored manifest's bytes here would change its integrity hash. Surfacing it
 *     belongs to the install-warning channel, not to this validator.
 */
export type RetiredVocabularyPolicy = "reject" | "tolerate";

/**
 * The retired agent field and the message naming its replacement, returned on
 * the author direction of {@link validateManifest}.
 */
const RETIRED_RUNTIME_TOOLS_ERROR =
  'runtime_tools: `runtime_tools` is retired — declare `dependencies.integrations["@appstrate/platform"]` ' +
  "and select its tools (`log`, `note`, `pin`, `recall_memory`, `run_history`, `notify`) under " +
  '`integrations_configuration["@appstrate/platform"].tools`. `output` is injected when ' +
  "`output.schema` is declared and `publish_file` is always available, so neither is selected.";

/** Options for {@link validateManifest}. */
export interface ValidateManifestOptions {
  /**
   * Direction-dependent handling of the retired manifest vocabulary.
   * Default `"reject"` (author input). See {@link RetiredVocabularyPolicy}.
   */
  retiredVocabulary?: RetiredVocabularyPolicy;
}

/**
 * Validate a raw manifest object by dispatching to the appropriate type-specific schema.
 * Determines the schema from the `type` field (agent, skill, integration) and validates accordingly.
 * @param raw - The raw manifest object to validate (typically parsed from JSON)
 * @param options - Direction of the call; see {@link ValidateManifestOptions}. The
 *   default is the safe one: author input declaring a retired key fails.
 * @returns Validation result with parsed manifest on success, or error messages on failure
 */
export function validateManifest(
  raw: unknown,
  options?: ValidateManifestOptions,
): ValidateManifestResult {
  // AFPS: `type` is the canonical discriminator and MUST be one of
  // `agent | skill | mcp-server | integration`. An unknown or missing `type`
  // is a dispatcher-level error, not a partial base-schema validation
  // failure — fail fast with a single structured Zod issue keyed on
  // `["type"]` so callers/UI get a typed signal rather than a permissive
  // list of base-schema field errors.
  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      errors: [
        "type: Unknown package type — manifest must declare type as one of: agent, skill, mcp-server, integration",
      ],
    };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  // Retired vocabulary: on the author direction, reject and name the
  // replacement. See {@link RetiredVocabularyPolicy} for why the keys still
  // parse. Checked before the type dispatch because every package type may
  // declare `dependencies`.
  if (options?.retiredVocabulary !== "tolerate") {
    const errors = findRetiredDependencyKeys(obj).map(
      ({ key, replacement }) =>
        `dependencies.${key}: \`dependencies.${key}\` is a retired AFPS 1.x key — rename it to \`dependencies.${replacement}\`. No consumer reads it, so the dependencies declared under it are silently ignored.`,
    );
    if (type === "agent" && Object.prototype.hasOwnProperty.call(obj, "runtime_tools")) {
      errors.push(RETIRED_RUNTIME_TOOLS_ERROR);
    }
    if (errors.length > 0) return { valid: false, errors };
  }

  // AFPS (§3.4): mcp-server identity lives at the manifest root —
  // `type: "mcp-server"`, `name`, `schema_version`, and `dependencies` are
  // all root fields. Dispatch purely on the root `type` discriminator.
  if (type === "mcp-server") return parseWithSchema(mcpServerManifestSchema, raw);
  if (type === "agent") return parseWithSchema(agentManifestSchema, raw);
  if (type === "skill") return parseWithSchema(skillManifestSchema, raw);
  if (type === "integration") return parseWithSchema(integrationManifestSchema, raw);

  // Unknown / missing type: emit a single typed issue and stop. Any value
  // that isn't one of the four canonical package types lands here and
  // produces the typed error rather than a confusing list of partial
  // base-schema errors.
  const received =
    typeof type === "string" ? `"${type}"` : type === undefined ? "missing" : String(type);
  return {
    valid: false,
    errors: [
      `type: Unknown package type ${received} — manifest must declare type as one of: agent, skill, mcp-server, integration`,
    ],
  };
}

/**
 * Extract name and description from a SKILL.md file's YAML frontmatter.
 *
 * Parsed by `parseSkillFrontmatter` — two parsers would let this read a name the
 * write-path gate rejects. This wrapper only adds warnings, and never throws.
 *
 * @param content - The full text content of a SKILL.md file
 * @returns Extracted name, description, and any parsing warnings
 */
export function extractSkillMeta(content: string): {
  name: string;
  description: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const { found, error, name, description } = parseSkillFrontmatter(content);
  if (!found) {
    warnings.push("No YAML frontmatter detected (expected --- ... --- block)");
    return { name: "", description: "", warnings };
  }
  if (error) {
    warnings.push(`Could not read YAML frontmatter: ${error}`);
    return { name: "", description: "", warnings };
  }

  if (!name) {
    warnings.push("Missing 'name' field in YAML frontmatter");
  }
  if (!description) {
    warnings.push("Missing 'description' field in YAML frontmatter");
  }

  return { name, description, warnings };
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
 * open (`unknown`) to accept both the bare-string and AFPS §4.1
 * object forms — only the keys are read.
 */
export function findMissingDependencies(
  required: Record<string, unknown>,
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  return Object.keys(required).filter((id) => !installed.has(id));
}
