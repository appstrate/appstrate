// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Derive {@link PlatformPromptOptions} from a {@link Bundle} alone.
 *
 * The bundle is self-describing — its root package holds the prompt
 * template + input/config/output schemas, and every non-root package
 * declares its own `type` (tool / skill / provider) in its manifest.
 * That is enough to compute every section of the platform preamble
 * that does not require live platform state (DB, sidecar, credentials).
 *
 * Callers pass an {@link ExecutionContext} for state/memories/history
 * and an {@link overrides} bag for platform-specific fields:
 *
 *   - `platformName`: display name in `## System`
 *   - `uploads`: only the platform can enumerate these (DB-backed)
 *   - `runHistoryApi`: only enable when a sidecar / proxy is wired
 *   - `providers`: pre-enriched list — merged over the bundle-derived
 *     providers by `id`, letting the platform add `authorizedUris`
 *     resolved via `@appstrate/connect` without re-deriving everything
 *   - any other field to override the bundle-derived value verbatim
 *
 * This helper NEVER imports anything outside `@appstrate/afps-runtime`.
 * Keeping it agnostic is what lets `afps run`, `appstrate run`, and the
 * platform container runner produce byte-identical prompts from the
 * same inputs.
 */

import type { Bundle, BundlePackage } from "./types.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type {
  PlatformPromptOptions,
  PlatformPromptProvider,
  PlatformPromptSchema,
  PlatformPromptTool,
} from "./platform-prompt.ts";
import { parsePackageIdentity } from "./types.ts";

/** Plain-object narrowing used throughout the helper. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract `prompt.md` bytes from the bundle root as UTF-8 text. */
function readRootPromptTemplate(bundle: Bundle): string {
  const root = bundle.packages.get(bundle.root);
  const bytes = root?.files.get("prompt.md");
  return bytes ? new TextDecoder().decode(bytes) : "";
}

/** Read `manifest.schemaVersion` from the root package if declared. */
function readSchemaVersion(bundle: Bundle): string | undefined {
  const root = bundle.packages.get(bundle.root);
  const v = (root?.manifest as Record<string, unknown> | undefined)?.["schemaVersion"];
  return typeof v === "string" ? v : undefined;
}

/** Read `manifest.timeout` (seconds) from the root package if declared. */
function readTimeoutSeconds(bundle: Bundle): number | undefined {
  const root = bundle.packages.get(bundle.root);
  const v = (root?.manifest as Record<string, unknown> | undefined)?.["timeout"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Extract the AFPS 1.3 `{ schema, fileConstraints?, uiHints?, … }` wrapper
 * for input/config/output sections. Returns the inner JSON Schema when
 * present, or `undefined`.
 */
function readSchemaSection(
  manifest: Record<string, unknown> | undefined,
  key: "input" | "config" | "output",
): Record<string, unknown> | undefined {
  const section = manifest?.[key];
  if (!isPlainObject(section)) return undefined;
  const schema = section["schema"];
  return isPlainObject(schema) ? schema : undefined;
}

/** Narrow a loose schema shape to the minimal `{properties?, required?}`. */
function asPromptSchema(
  schema: Record<string, unknown> | undefined,
): PlatformPromptSchema | undefined {
  if (!schema) return undefined;
  const out: PlatformPromptSchema = {};
  if (isPlainObject(schema["properties"])) {
    out.properties = schema["properties"] as Record<string, unknown>;
  }
  if (Array.isArray(schema["required"])) {
    out.required = (schema["required"] as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return out;
}

/**
 * Build `PlatformPromptTool` from a bundle package's manifest.
 * Falls back to the parsed package id when name is absent.
 */
function toolFromPackage(pkg: BundlePackage): PlatformPromptTool {
  const manifest = pkg.manifest as Record<string, unknown>;
  const parsed = parsePackageIdentity(pkg.identity);
  const id = parsed ? parsed.packageId : pkg.identity;
  const out: PlatformPromptTool = { id };
  if (typeof manifest["name"] === "string") out.name = manifest["name"] as string;
  if (typeof manifest["description"] === "string") {
    out.description = manifest["description"] as string;
  }
  return out;
}

/**
 * Derive provider meta from a provider package's manifest. Reads
 * `authorizedUris` / `allowAllUris` from `manifest.definition` per AFPS
 * spec §7.5 / §8.6; surfaces `docsUrl` and `authMode` when declared.
 * Flags `hasProviderDoc: true` when a `PROVIDER.md` file ships in the
 * package.
 */
function providerFromPackage(pkg: BundlePackage): PlatformPromptProvider {
  const manifest = pkg.manifest as Record<string, unknown>;
  const parsed = parsePackageIdentity(pkg.identity);
  const id = parsed ? parsed.packageId : pkg.identity;

  const def = isPlainObject(manifest["definition"]) ? manifest["definition"] : {};

  const out: PlatformPromptProvider = { id };
  if (typeof manifest["name"] === "string") out.displayName = manifest["name"] as string;
  if (typeof def["authMode"] === "string") out.authMode = def["authMode"] as string;
  if (typeof def["docsUrl"] === "string") out.docsUrl = def["docsUrl"] as string;
  if (Array.isArray(def["authorizedUris"])) {
    out.authorizedUris = (def["authorizedUris"] as unknown[]).filter(
      (u): u is string => typeof u === "string",
    );
  }
  if (typeof def["allowAllUris"] === "boolean") {
    out.allowAllUris = def["allowAllUris"] as boolean;
  }
  if (pkg.files.has("PROVIDER.md")) out.hasProviderDoc = true;
  return out;
}

/**
 * Walk all non-root packages once and classify by `manifest.type`.
 * Single pass — keeps the traversal cost predictable on large bundles.
 */
function walkDependencies(bundle: Bundle): {
  tools: PlatformPromptTool[];
  skills: PlatformPromptTool[];
  providers: PlatformPromptProvider[];
  toolDocs: Array<{ id: string; content: string }>;
} {
  const tools: PlatformPromptTool[] = [];
  const skills: PlatformPromptTool[] = [];
  const providers: PlatformPromptProvider[] = [];
  const toolDocs: Array<{ id: string; content: string }> = [];
  const decoder = new TextDecoder();

  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const type = (pkg.manifest as Record<string, unknown>)["type"];
    if (type === "tool") {
      tools.push(toolFromPackage(pkg));
      const md = pkg.files.get("TOOL.md");
      if (md) {
        const parsed = parsePackageIdentity(identity);
        if (parsed) toolDocs.push({ id: parsed.packageId, content: decoder.decode(md) });
      }
    } else if (type === "skill") {
      skills.push(toolFromPackage(pkg));
    } else if (type === "provider") {
      providers.push(providerFromPackage(pkg));
    }
  }

  return { tools, skills, providers, toolDocs };
}

/**
 * Merge override providers over bundle-derived providers by `id`.
 * Override fields win on conflict; bundle fields fill gaps. Order is
 * preserved from the bundle walk (deterministic) with overrides-only
 * entries appended at the end.
 */
function mergeProviders(
  fromBundle: ReadonlyArray<PlatformPromptProvider>,
  fromOverride: ReadonlyArray<PlatformPromptProvider> | undefined,
): ReadonlyArray<PlatformPromptProvider> {
  if (!fromOverride || fromOverride.length === 0) return fromBundle;
  const overrideById = new Map(fromOverride.map((p) => [p.id, p]));
  const merged: PlatformPromptProvider[] = fromBundle.map((p) => {
    const o = overrideById.get(p.id);
    return o ? { ...p, ...o } : p;
  });
  const seen = new Set(fromBundle.map((p) => p.id));
  for (const o of fromOverride) {
    if (!seen.has(o.id)) merged.push(o);
  }
  return merged;
}

export interface BuildPlatformPromptInputsOverrides extends Partial<
  Omit<PlatformPromptOptions, "context">
> {
  /**
   * When `true`, the `providers` override REPLACES bundle-derived
   * providers instead of merging by id. Platforms that compute a
   * connection-filtered list (e.g. "only providers with credentials
   * wired") should set this; the default merge-by-id semantic is
   * geared at enrichment (e.g. add `authorizedUris` to bundle meta).
   */
  providersReplace?: boolean;
}

/**
 * Derive a fully-populated {@link PlatformPromptOptions} from a bundle
 * plus an execution context, with optional overrides for platform-
 * dependent fields. The returned object is ready to pass straight to
 * `renderPlatformPrompt`.
 *
 * Behaviour:
 *   - Bundle-derived fields are overridden **verbatim** when present in
 *     `overrides`, except `providers` which is merged by id (see
 *     {@link mergeProviders}) so the platform can enrich URIs without
 *     re-deriving displayName / authMode / docs.
 *   - `context` is always the caller's; the bundle never overrides it.
 *   - Absent overrides leave bundle-derived defaults in place.
 */
export function buildPlatformPromptInputs(
  bundle: Bundle,
  context: ExecutionContext,
  overrides: BuildPlatformPromptInputsOverrides = {},
): PlatformPromptOptions {
  const root = bundle.packages.get(bundle.root);
  const rootManifest = root?.manifest as Record<string, unknown> | undefined;

  const { tools, skills, providers, toolDocs } = walkDependencies(bundle);

  const inputSchema = asPromptSchema(readSchemaSection(rootManifest, "input"));
  const configSchema = asPromptSchema(readSchemaSection(rootManifest, "config"));
  const outputSchema = readSchemaSection(rootManifest, "output");

  const derived: PlatformPromptOptions = {
    template: readRootPromptTemplate(bundle),
    context,
    ...(readSchemaVersion(bundle) !== undefined
      ? { schemaVersion: readSchemaVersion(bundle)! }
      : {}),
    ...(readTimeoutSeconds(bundle) !== undefined
      ? { timeoutSeconds: readTimeoutSeconds(bundle)! }
      : {}),
    availableTools: tools,
    availableSkills: skills,
    toolDocs,
    providers,
    ...(inputSchema ? { inputSchema } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };

  // Apply overrides. `providers` is merged by id by default;
  // `providersReplace: true` swaps to full replacement. Everything
  // else is replaced verbatim. Undefined override values are ignored
  // so callers can opt into "use derived" by simply omitting the key.
  const merged: PlatformPromptOptions = { ...derived };
  const { providersReplace, ...standard } = overrides;
  for (const [key, value] of Object.entries(standard) as Array<
    [keyof PlatformPromptOptions, unknown]
  >) {
    if (value === undefined) continue;
    if (key === "providers") {
      merged.providers = providersReplace
        ? (value as ReadonlyArray<PlatformPromptProvider>)
        : mergeProviders(derived.providers ?? [], value as ReadonlyArray<PlatformPromptProvider>);
    } else {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return merged;
}
