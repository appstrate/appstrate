// SPDX-License-Identifier: Apache-2.0

/**
 * Connection variables (AFPS §7.12) for the live tiers. A manifest whose
 * `source.remote.url` or oauth2 `issuer` is a URL template has no upstream of
 * its own: the harness renders it against one instance, exactly as a
 * connection would.
 *
 * Each variable takes its `default` from `variables.schema` (the hosted service
 * — gitlab.com, api.twenty.com), overridden per package by
 * `CONFORMANCE_VARIABLES`, a JSON object mapping package id → `{ name: value }`
 * (e.g. `{"@appstrate/coolify-mcp":{"base_url":"https://coolify.example.com"}}`).
 * A variable with neither leaves the template unrendered and the live check is
 * skipped with a WARN naming the missing variable.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import {
  isVariableTemplate,
  renderUrlTemplate,
  variableRefs,
} from "@appstrate/afps-shared/connection-variables";

const ENV_KEY = "CONFORMANCE_VARIABLES";

let overrides: Record<string, Record<string, string>> | null = null;

function loadOverrides(): Record<string, Record<string, string>> {
  if (overrides) return overrides;
  overrides = {};
  const raw = process.env[ENV_KEY];
  if (!raw) return overrides;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [packageId, values] of Object.entries(parsed as Record<string, unknown>)) {
        if (!values || typeof values !== "object") continue;
        overrides[packageId] = Object.fromEntries(
          Object.entries(values as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    }
  } catch {
    // Invalid JSON → no overrides; templates fall back to their defaults.
  }
  return overrides;
}

/** The values a package's templates render with: schema defaults, then overrides. */
export function conformanceVariables(entry: SystemPackageEntry): Record<string, string> {
  const schema = (entry.manifest as { variables?: { schema?: { properties?: unknown } } }).variables
    ?.schema?.properties;
  const values: Record<string, string> = {};
  if (schema && typeof schema === "object") {
    for (const [name, property] of Object.entries(
      schema as Record<string, { default?: unknown }>,
    )) {
      if (typeof property?.default === "string") values[name] = property.default;
    }
  }
  return { ...values, ...loadOverrides()[entry.packageId] };
}

/**
 * A URL-valued manifest field as the harness should contact it: a literal as is,
 * a template rendered with {@link conformanceVariables}. `skip` names why a
 * template cannot be rendered here (a variable with no default nor override, or
 * a value its form refuses).
 */
export function renderForConformance(
  entry: SystemPackageEntry,
  value: string,
): { url: string } | { skip: string } {
  if (!isVariableTemplate(value)) return { url: value };
  const values = conformanceVariables(entry);
  const missing = variableRefs(value).filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    return {
      skip: `no instance to test: ${missing.join(", ")} has no default — set ${ENV_KEY}["${entry.packageId}"]`,
    };
  }
  const url = renderUrlTemplate(value, values);
  return url === null
    ? { skip: `${value} does not render with ${JSON.stringify(values)}` }
    : { url };
}

/** Test-only hook: forget parsed overrides so a test can set the env var. */
export function __resetConformanceVariables(): void {
  overrides = null;
}
