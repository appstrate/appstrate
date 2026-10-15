// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Derive {@link PlatformPromptOptions} from a {@link Bundle} alone.
 *
 * The bundle is self-describing — its root package holds the prompt
 * template + input/output schemas, and every non-root package
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

import type { Bundle } from "./types.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type {
  PlatformPromptIntegration,
  PlatformPromptOptions,
  PlatformPromptSchema,
} from "./platform-prompt.ts";
import { PI_INTEGRATIONS_DIR } from "./workspace-layout.ts";
import { readIntegrationRefs } from "../resolvers/integration-api-call.ts";
import { resolvePackageRef } from "../resolvers/bundle-adapter.ts";

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
 * for input/output sections. Returns the inner JSON Schema when
 * present, or `undefined`.
 */
function readSchemaSection(
  manifest: Record<string, unknown> | undefined,
  key: "input" | "output",
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
 * One catalog entry per integration the ROOT manifest declares, in
 * declaration order: a member pulled in by a skill is not the agent's.
 * The member is found by the rule the `api_call` wiring uses; when the
 * bundle carries it, it adds `description` and the `location` of its
 * `INTEGRATION.md` as the runner materialises it under
 * {@link PI_INTEGRATIONS_DIR}. A declared integration without a member
 * (skipped as optional) still yields `{ id }`, so a host can list an
 * integration it started even when its doc is not in the bundle.
 */
export function integrationsFromBundle(bundle: Bundle): PlatformPromptIntegration[] {
  return readIntegrationRefs(bundle).map((ref) => {
    const entry: PlatformPromptIntegration = { id: ref.name };
    const pkg = resolvePackageRef(bundle, ref);
    if (!pkg) return entry;
    const description = (pkg.manifest as Record<string, unknown>)["description"];
    if (typeof description === "string") entry.description = description;
    if (pkg.files.has("INTEGRATION.md")) {
      entry.location = `${PI_INTEGRATIONS_DIR}/${ref.name}/INTEGRATION.md`;
    }
    return entry;
  });
}

export type BuildPlatformPromptInputsOverrides = Partial<
  Omit<PlatformPromptOptions, "context" | "integrations">
> & {
  /**
   * Ids of the integrations this run actually starts. The catalog lists
   * the bundle's integrations whose id is in this set; absent, it lists none.
   */
  availableIntegrationIds?: Iterable<string>;
};

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
 *   - `integrations` is {@link integrationsFromBundle} restricted to
 *     `overrides.availableIntegrationIds` (none when absent).
 *   - Absent overrides leave bundle-derived defaults in place.
 */
export function buildPlatformPromptInputs(
  bundle: Bundle,
  context: ExecutionContext,
  overrides: BuildPlatformPromptInputsOverrides = {},
): PlatformPromptOptions {
  const root = bundle.packages.get(bundle.root);
  const rootManifest = root?.manifest as Record<string, unknown> | undefined;

  const { availableIntegrationIds, ...promptOverrides } = overrides;
  const available = new Set(availableIntegrationIds ?? []);

  const inputSchema = asPromptSchema(readSchemaSection(rootManifest, "input"));
  const outputSchema = readSchemaSection(rootManifest, "output");

  const derived: PlatformPromptOptions = {
    template: readRootPromptTemplate(bundle),
    context,
    ...(readTimeoutSeconds(bundle) !== undefined
      ? { timeoutSeconds: readTimeoutSeconds(bundle)! }
      : {}),
    integrations: integrationsFromBundle(bundle).filter((integ) => available.has(integ.id)),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };

  // Apply overrides verbatim. Undefined override values are ignored so
  // callers can opt into "use derived" by simply omitting the key.
  const merged: PlatformPromptOptions = { ...derived };
  for (const [key, value] of Object.entries(promptOverrides) as Array<
    [keyof PlatformPromptOptions, unknown]
  >) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }

  return merged;
}
