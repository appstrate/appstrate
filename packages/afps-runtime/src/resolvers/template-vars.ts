// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * Canonical `{{var}}` substitution for the AGENT-facing grammar: an `api_call`'s
 * `{{field}}` placeholders (credential proxy, sidecar MITM, CLI resolver) and the
 * `{{name}}` login inputs. Manifest value templates use `{$credential.<field>}`
 * (`@appstrate/afps-shared/credential-template`).
 *
 * Whitespace inside `{{ … }}` is tolerated so hand-written templates can
 * keep `{{ field }}`. Two missing-key policies, picked per call site:
 *
 *   - default (`keepUnresolved: false`) → unknown placeholders render empty.
 *   - `keepUnresolved: true` → unknown placeholders are left intact so the
 *     caller can fail closed by scanning for survivors (the credential-proxy
 *     pattern — never silently blank a credential into a request).
 *
 * NOTE: distinct from the Mustache renderer in `../template/mustache.ts`,
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
    // Own properties only: `{{constructor}}` must not resolve to Object.prototype's.
    if (Object.hasOwn(fields, key)) return fields[key]!;
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
 * The keys of `template`'s `{{key}}` placeholders that `fields` does not own: what a proxy refuses
 * to send. Read on the template, never the substituted string, where a `{{word}}` inside a
 * credential value is no placeholder (and naming it would echo the secret).
 */
export function unresolvedPlaceholders(
  template: string,
  fields: Readonly<Record<string, string>>,
): string[] {
  return [...template.matchAll(VAR_PLACEHOLDER)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(fields, key));
}

/**
 * True when `input` contains at least one `{{key}}` placeholder whose key is
 * an own property of `fields`. Used by the credential-exfil guard
 * ({@link ./credential-guard.ts}) to detect calls that substitute a
 * credential field into an agent-controlled URL / header / body.
 */
export function referencesField(input: string, fields: Readonly<Record<string, unknown>>): boolean {
  for (const match of input.matchAll(VAR_PLACEHOLDER)) {
    if (Object.hasOwn(fields, match[1]!)) return true;
  }
  return false;
}

/**
 * The host `template` (a URL template) names, each `{{key}}` in it written as `{{key}}`: what a
 * message echoes for the target. Never a rendered value, and an untemplated host shown as the
 * caller wrote it, so an echo never tells whether a literal host matches a credential value. A
 * leading `{{key}}` stands for a whole base URL; a templated host that does not parse (a
 * `{{port}}`) is `<templated>`.
 */
export function templateHost(template: string): string {
  const keys: string[] = [];
  const marked = template.replace(VAR_PLACEHOLDER, (_match, key: string) => {
    keys.push(key);
    return `xph${keys.length - 1}x`;
  });
  const url =
    parseUrl(marked) ?? (/^\s*\{\{/.test(template) ? parseUrl(`https://${marked}`) : null);
  if (!url) return keys.length > 0 ? "<templated>" : "<unparseable>";
  return url.hostname.replace(/xph(\d+)x/g, (match, i: string) => {
    const key = keys[Number(i)];
    return key === undefined ? match : `{{${key}}}`;
  });
}

function parseUrl(input: string): URL | null {
  return URL.canParse(input) ? new URL(input) : null;
}
