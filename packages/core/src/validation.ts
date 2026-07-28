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
import { SELECTABLE_RUNTIME_TOOLS, isSelectableRuntimeTool } from "./runtime-tools-catalog.ts";
import { findRetiredDependencyKeys } from "./dependencies.ts";

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
 * (`apps/api/src/services/integration-install-warnings.ts`) only emits
 * non-blocking install-time warnings — reserved-prefix keys are already
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
 * no longer owns any `_meta` policy.
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
      error: 'schema_version must follow MAJOR.MINOR format with no leading zeros (e.g. "0.1")',
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

/**
 * Zod schema for agent manifests — extends AFPS with relaxed optional metadata for local drafts
 * AND the Phase 1.0 `dependencies.integrations` map (proposal §4.2.3).
 */
const agentManifestObjectSchema = afpsAgentManifestObjectSchema.extend({
  // All standard fields (name, version, schema_version, dependencies,
  // display_name, input/output/config, timeout) inherited from the AFPS
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
  // The §4.4 `tools` wildcard (`string[] | "*"`, issue #547) is supported by
  // the canonical schema as of @afps-spec/schema@0.5.0; no local widening is
  // needed — the inherited shape already matches the Appstrate runtime
  // contract (`dependencies.ts` `ToolsWildcard` / `isToolsWildcard`).
  // First-party runtime tools enabled for this agent — all opt-in, none
  // auto-injected (`output` included). `output` is required to be present
  // only when an output schema is declared (enforced by the superRefine
  // below). Snake_case `runtime_tools`. This is an
  // Appstrate manifest extension with no AFPS equivalent — kept as a
  // documented top-level snake_case field rather than namespaced under
  // `_meta`, because it is woven through the run pipeline (catalog
  // validation, prompt builder, sidecar tool registration) and namespacing
  // it would be disproportionate.
  runtime_tools: z.array(z.enum(SELECTABLE_RUNTIME_TOOLS)).optional(),
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
  // AFPS §4.4 — re-apply the canonical orphan-key rule (the base AFPS schema
  // is the plain object here so it stays extendable; the rule lives in the
  // shared `refineIntegrationsConfiguration` to avoid drift).
  refineIntegrationsConfiguration(m, ctx);

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
      /**
       * `runtime_tools` ids stripped from the parsed manifest because the
       * platform retired them. Always empty unless the caller opted into
       * {@link ValidateManifestOptions.retiredRuntimeTools} `"drop"` — the
       * drop is silent by construction, so read this to surface it (log,
       * warn the operator) instead of losing the signal.
       */
      droppedRuntimeTools: string[];
    }
  | { valid: false; errors: string[]; manifest?: undefined; droppedRuntimeTools?: undefined };

function parseWithSchema(
  schema:
    | typeof manifestSchema
    | typeof agentManifestSchema
    | typeof skillManifestSchema
    | typeof integrationManifestSchema
    | typeof mcpServerManifestSchema,
  raw: unknown,
  droppedRuntimeTools: string[] = [],
): ValidateManifestResult {
  // `_meta` validation is delegated entirely to the canonical per-type schema.
  // As of AFPS 0.1 the upstream `metaSchema` is STRICT — it enforces the
  // Appendix B `META_NAMESPACE_KEY` pattern and hard-rejects the reserved
  // `mcp/` / `modelcontextprotocol/` prefixes at parse time, so a malformed or
  // reserved `_meta` key already surfaces as a `safeParse` failure below.
  const result = schema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { valid: false, errors };
  }

  return { valid: true, errors: [], manifest: result.data, droppedRuntimeTools };
}

/**
 * Strip the `runtime_tools` entries the platform no longer knows how to build
 * from an ALREADY-STORED agent manifest.
 *
 * The runtime-tool set evolves, and a removal is not retroactive: manifests
 * persisted before it (DB drafts, and published ZIPs which are immutable by
 * construction) keep the retired id forever. Read paths re-validate the stored
 * manifest, so a hard enum rejection there would make every such agent
 * permanently unrunnable. The runner already ignores ids it cannot build
 * ({@link buildRuntimeToolDefs} in `runtime-tool-defs.ts`); this mirrors that
 * contract for the read direction.
 *
 * Purely structural — no Zod round-trip. Key order, unknown fields and the
 * absence of schema defaults are preserved exactly, because the version
 * snapshot path serialises the result into an integrity-hashed artifact: a
 * re-parse that reordered keys would silently defeat publish dedup (#896).
 * Returns the input untouched (same reference) when nothing needs dropping.
 *
 * **When a drop empties the list, the key is REMOVED, not left as `[]`.** AFPS
 * makes `runtime_tools` optional with no default, so absent and `[]` parse to
 * the same agent — but they are different bytes, and this helper is not the
 * only writer: the agent editor's `setRuntimeTools` also drops the field on an
 * empty selection. Emitting `[]` here would mean an agent whose only tool was
 * retired serialises one way through the editor and another way through the
 * publish path, i.e. two integrity hashes for one manifest. Deleting a key does
 * not reorder the survivors, so the structural contract above still holds.
 *
 * That rule is scoped to the drop, and deliberately so: this is a DROPPER, not
 * a canonicaliser. A manifest that *already* declares `runtime_tools: []` — a
 * shape no platform writer emits (the editor deletes on an empty selection, the
 * schema has no `.default([])`, and the publish path only rewrites what it
 * dropped) but which AFPS permits and a CLI/curl/hand-written manifest.json can
 * author — is returned UNTOUCHED, key and all. Canonicalising it would mean
 * rewriting the bytes of a manifest with nothing wrong in it, purely as a side
 * effect of asking "are any ids retired?" — which is precisely the blast-radius
 * widening the structural contract exists to prevent, and it would cost the
 * same-reference identity above. Absent and `[]` therefore remain two accepted
 * spellings of "no runtime tools" for an author who insists on the latter; what
 * this helper guarantees is only that IT never mints the second one.
 *
 * Only `type: "agent"` manifests carry `runtime_tools`; any other type is
 * returned as-is.
 */
export function dropRetiredRuntimeTools(manifest: Record<string, unknown>): {
  manifest: Record<string, unknown>;
  dropped: string[];
} {
  if (manifest.type !== "agent") return { manifest, dropped: [] };
  const raw = manifest.runtime_tools;
  if (!Array.isArray(raw)) return { manifest, dropped: [] };
  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    if (isSelectableRuntimeTool(entry)) kept.push(entry);
    else dropped.push(String(entry));
  }
  if (dropped.length === 0) return { manifest, dropped: [] };
  const next = { ...manifest };
  if (kept.length > 0) next.runtime_tools = kept;
  else delete next.runtime_tools;
  return { manifest: next, dropped };
}

/**
 * How {@link validateManifest} treats the manifest vocabulary the platform
 * retired — the one behaviour that MUST differ by direction. It governs BOTH
 * retired kinds, because they are two expressions of a single question ("is
 * this manifest author input, or something already persisted?") and splitting
 * them into two flags would let a future call site set one and forget the
 * other, which is precisely how the author-input rejection was lost once
 * already (#1021):
 *
 *   1. `runtime_tools` ids the platform retired (or an author mistyped).
 *   2. `dependencies` keys AFPS 2.0 retired — `tools` (now `mcp_servers`) and
 *      `providers` (now `integrations`).
 *
 * The two policy values:
 *
 *   - `"reject"` (default) — the manifest is AUTHOR INPUT (create, update,
 *     import, an inline manifest from an API client, a repo-authored system
 *     package). A retired or misspelled id is a mistake the author must see;
 *     silently dropping it ships an agent missing a tool with no signal, and a
 *     retired dependency key declares a dependency no reader will ever honour.
 *   - `"drop"` — the manifest was ALREADY PERSISTED (a stored draft, a
 *     published version snapshot). Those cannot be fixed in place — a
 *     published artifact is immutable by construction — so:
 *       - retired `runtime_tools` ids are stripped and the manifest stays valid
 *         and runnable (read {@link ValidateManifestResult.droppedRuntimeTools}
 *         to log what went), and
 *       - a retired `dependencies` key is TOLERATED, left exactly where it is.
 *         It is inert (no reader has ever read it) so there is nothing to strip,
 *         and rewriting a stored manifest's bytes here would change its
 *         integrity hash. Surfacing it belongs to the install-warning channel,
 *         not to this validator.
 *
 * The name is historical — the flag predates the dependency-key rule and is
 * part of the published `@appstrate/core` surface, so it is kept rather than
 * renamed for a nicety.
 */
export type RetiredRuntimeToolsPolicy = "reject" | "drop";

/** Options for {@link validateManifest}. */
export interface ValidateManifestOptions {
  /**
   * Direction-dependent handling of retired manifest vocabulary — retired
   * `runtime_tools` ids AND retired AFPS 1.x `dependencies` keys. Default
   * `"reject"` (author input). See {@link RetiredRuntimeToolsPolicy}.
   */
  retiredRuntimeTools?: RetiredRuntimeToolsPolicy;
}

/**
 * Validate a raw manifest object by dispatching to the appropriate type-specific schema.
 * Determines the schema from the `type` field (agent, skill, integration) and validates accordingly.
 * @param raw - The raw manifest object to validate (typically parsed from JSON)
 * @param options - Direction of the call; see {@link ValidateManifestOptions}. The
 *   default is the safe one: author input with an unknown `runtime_tools` id fails.
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

  // AFPS 1.x retired dependency vocabulary: on the author direction, reject
  // and name the replacement key (#1021). See {@link RetiredRuntimeToolsPolicy}
  // for why the keys still parse. Checked before the type dispatch because
  // every package type may declare `dependencies`.
  if (options?.retiredRuntimeTools !== "drop") {
    const retiredDeps = findRetiredDependencyKeys(obj);
    if (retiredDeps.length > 0) {
      return {
        valid: false,
        errors: retiredDeps.map(
          ({ key, replacement }) =>
            `dependencies.${key}: \`dependencies.${key}\` is a retired AFPS 1.x key — rename it to \`dependencies.${replacement}\`. No consumer reads it, so the dependencies declared under it are silently ignored.`,
        ),
      };
    }
  }

  // AFPS (§3.4): mcp-server identity lives at the manifest root —
  // `type: "mcp-server"`, `name`, `schema_version`, and `dependencies` are
  // all root fields. Dispatch purely on the root `type` discriminator.
  if (type === "mcp-server") return parseWithSchema(mcpServerManifestSchema, raw);
  if (type === "agent") {
    if (options?.retiredRuntimeTools !== "drop") {
      // Author direction (default): the `runtime_tools` enum rejects, so a
      // typo or a retired id surfaces as a field error the editor can render.
      return parseWithSchema(agentManifestSchema, raw);
    }
    const { manifest, dropped } = dropRetiredRuntimeTools(obj);
    return parseWithSchema(agentManifestSchema, manifest, dropped);
  }
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
  // Anchor to the start of a line (`^` + `m` flag) so a longer key that
  // ends in the target token (e.g. `displayname:` / `x-description:`) does
  // not shadow the real top-level `name:` / `description:` field.
  const nameMatch = fm.match(/^name:[ \t]*(.+)/m);
  const descMatch = fm.match(/^description:[ \t]*(.+)/m);

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
