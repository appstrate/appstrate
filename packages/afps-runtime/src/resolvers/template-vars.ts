// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * Canonical `{{var}}` credential substitution, shared by every layer that
 * injects credentials into headers / URLs / bodies:
 *
 *   - the platform credential proxy + sidecar MITM (`@appstrate/connect`'s
 *     `substituteVars` re-export — fail-closed, `keepUnresolved: true`),
 *   - the `delivery.http` plan renderer ({@link ./http-delivery.ts}),
 *   - the portable `appstrate run` integration resolver
 *     ({@link ./integration-api-call.ts}).
 *
 * Whitespace inside `{{ … }}` is tolerated so hand-written templates can
 * keep `{{ field }}`. Two missing-key policies, picked per call site:
 *
 *   - default (`keepUnresolved: false`) → unknown placeholders render empty.
 *     Used by `delivery.http` rendering, where a missing field means "no
 *     value to inject".
 *   - `keepUnresolved: true` → unknown placeholders are left intact so the
 *     caller can fail closed by scanning for survivors (the credential-proxy
 *     pattern — never silently blank a credential into a request).
 *
 * NOTE: distinct from the Mustache renderer in `@appstrate/afps-runtime/template`,
 * which renders agent prompts from a structured view. This one is a flat
 * `{{name}}` → `fields[name]` substitution over a string→string credential map.
 */
export function substituteVars(
  input: string,
  fields: Readonly<Record<string, string>>,
  opts?: { keepUnresolved?: boolean },
): string {
  const keep = opts?.keepUnresolved === true;
  return input.replace(VAR_PLACEHOLDER, (match, key: string) => {
    if (key in fields) return fields[key]!;
    return keep ? match : "";
  });
}

/**
 * Canonical `{{ key }}` placeholder grammar — single source for every scanner
 * and substituter in this module. `String.replace` and `String.matchAll` are
 * both safe with a shared `g`-flag regex (`replace` ignores `lastIndex`;
 * `matchAll` clones the regex), so the constant carries no statefulness.
 */
const VAR_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * True when `input` contains at least one `{{key}}` placeholder whose key
 * exists in `fields`. Used by the credential-exfil guard in
 * {@link ./integration-api-call.ts} to detect calls that substitute a
 * credential field into an agent-controlled URL / header / body.
 */
export function referencesField(input: string, fields: Readonly<Record<string, unknown>>): boolean {
  for (const match of input.matchAll(VAR_PLACEHOLDER)) {
    if (match[1]! in fields) return true;
  }
  return false;
}
