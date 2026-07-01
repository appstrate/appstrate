// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Derive {@link PlatformPromptOptions} from a {@link Bundle} alone.
 *
 * The bundle is self-describing — its root package holds the prompt
 * template + input/config/output schemas, and every non-root package
 * declares its own `type` (skill / mcp-server / integration) in its
 * manifest. That is enough to compute every section of the platform
 * preamble that does not require live platform state (DB, sidecar,
 * credentials).
 *
 * Callers pass an {@link ExecutionContext} for state/memories/history
 * and an {@link overrides} bag for platform-specific fields:
 *
 *   - `platformName`: display name in `## System`
 *   - `uploads`: only the platform can enumerate these (DB-backed)
 *   - any other field to override the bundle-derived value verbatim
 *
 * This helper NEVER imports anything outside `@appstrate/afps-runtime`.
 * Keeping it agnostic is what lets `appstrate run` and the platform
 * container runner produce byte-identical prompts from the same inputs.
 */

import type { Bundle, BundlePackage } from "./types.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type {
  PlatformPromptOptions,
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

/** Read `manifest.timeout` (seconds) from the root package if declared. */
function readTimeoutSeconds(bundle: Bundle): number | undefined {
  const root = bundle.packages.get(bundle.root);
  const v = (root?.manifest as Record<string, unknown> | undefined)?.["timeout"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Extract the AFPS `{ schema, file_constraints?, ui_hints?, … }` wrapper
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
 * Build `PlatformPromptTool` from a skill package's manifest.
 *
 * Skills are workspace files, not LLM-facing tools, so the package
 * display `manifest.name`/`description` are the only inputs. Falls back
 * to the parsed package id when `name` is absent.
 */
function skillFromPackage(pkg: BundlePackage): PlatformPromptTool {
  const manifest = pkg.manifest as Record<string, unknown>;
  const parsed = parsePackageIdentity(pkg.identity);
  const id = parsed ? parsed.packageId : pkg.identity;
  const out: PlatformPromptTool = { id };
  if (typeof manifest["name"] === "string") {
    out.name = manifest["name"];
  }
  if (typeof manifest["description"] === "string") {
    out.description = manifest["description"];
  }
  return out;
}

/**
 * Walk all non-root packages once and collect the skill references.
 * Tools are NOT collected: every agent tool (runtime, integration,
 * first-party) is advertised to the model via MCP `tools/list`, so the
 * prompt no longer lists them or their docs (see `renderPlatformPrompt`).
 * Skills are not MCP tools — they are workspace files — so they keep
 * their prompt section.
 */
function walkDependencies(bundle: Bundle): { skills: PlatformPromptTool[] } {
  const skills: PlatformPromptTool[] = [];
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const type = (pkg.manifest as Record<string, unknown>)["type"];
    if (type === "skill") skills.push(skillFromPackage(pkg));
  }
  return { skills };
}

export type BuildPlatformPromptInputsOverrides = Partial<Omit<PlatformPromptOptions, "context">>;

/**
 * Derive a fully-populated {@link PlatformPromptOptions} from a bundle
 * plus an execution context, with optional overrides for platform-
 * dependent fields. The returned object is ready to pass straight to
 * `renderPlatformPrompt`.
 *
 * Behaviour:
 *   - Bundle-derived fields are overridden **verbatim** when present in
 *     `overrides`.
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

  const { skills } = walkDependencies(bundle);

  const inputSchema = asPromptSchema(readSchemaSection(rootManifest, "input"));
  const configSchema = asPromptSchema(readSchemaSection(rootManifest, "config"));
  const outputSchema = readSchemaSection(rootManifest, "output");

  const derived: PlatformPromptOptions = {
    template: readRootPromptTemplate(bundle),
    context,
    ...(readTimeoutSeconds(bundle) !== undefined
      ? { timeoutSeconds: readTimeoutSeconds(bundle)! }
      : {}),
    availableSkills: skills,
    ...(inputSchema ? { inputSchema } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };

  // Apply overrides verbatim. Undefined override values are ignored so
  // callers can opt into "use derived" by simply omitting the key.
  const merged: PlatformPromptOptions = { ...derived };
  for (const [key, value] of Object.entries(overrides) as Array<
    [keyof PlatformPromptOptions, unknown]
  >) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }

  return merged;
}
