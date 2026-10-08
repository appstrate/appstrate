// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `{$credential.<field>}` value-template renderer — the SINGLE
 * source of truth. Consumers import this module directly; core no longer
 * publishes a `./credential-template` subpath (removed in core 6.0.0).
 *
 * AFPS `delivery.http` / `delivery.env` / `delivery.files` value templates
 * reference an auth's decrypted credential bag via the `{$credential.<field>}`
 * syntax. This is a DISTINCT syntax from the `{{var}}` substitution handled by
 * `@appstrate/afps-runtime`'s `substituteVars` — there is exactly ONE
 * implementation per syntax, and this module owns `{$credential.<field>}`.
 *
 * A missing field renders empty (a missing credential field means "no value to
 * inject"). The empty-value behaviour is parametrised:
 *   - `emptyAs: "string"` (default) → returns `""` for an all-empty render
 *     (the `delivery.http` value-render policy: the caller decides whether to
 *     inject an empty header / synthesise a value such as basic-auth).
 *   - `emptyAs: "null"` → returns `null` for an all-empty render, so callers
 *     can skip env vars / files whose backing credential field is absent
 *     (the `delivery.env` / `delivery.files` "field missing → skip" policy).
 */

export const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;

const SINGLE_CREDENTIAL_REF = new RegExp(`^${CREDENTIAL_REF.source}$`);

/** Any `{$…}` runtime expression embedded in a template (AFPS §7.7). */
const EMBEDDED_EXPRESSION = /\{\$[^{}]*\}/g;

/** The field `expression` names when it is exactly one `{$credential.<field>}`, else `null`. */
export function parseCredentialRef(expression: string): string | null {
  return SINGLE_CREDENTIAL_REF.exec(expression)?.[1] ?? null;
}

/** The distinct `{$…}` expressions embedded in `template`, in order. */
export function templateExpressions(template: string): string[] {
  return [...new Set(template.match(EMBEDDED_EXPRESSION) ?? [])];
}

/** The embedded `{$…}` expressions of `template` that are not `{$credential.<field>}` references. */
export function unsupportedTemplateExpressions(template: string): string[] {
  return templateExpressions(template).filter((e) => parseCredentialRef(e) === null);
}

export interface RenderCredentialTemplateOptions {
  /**
   * What an all-empty render resolves to. `"string"` returns `""`; `"null"`
   * returns `null`. Defaults to `"string"`.
   */
  emptyAs?: "string" | "null";
}

export function renderCredentialTemplate(
  template: string,
  credential: Readonly<Record<string, string>>,
  opts?: RenderCredentialTemplateOptions & { emptyAs?: "string" },
): string;
export function renderCredentialTemplate(
  template: string,
  credential: Readonly<Record<string, string>>,
  opts: RenderCredentialTemplateOptions & { emptyAs: "null" },
): string | null;
export function renderCredentialTemplate(
  template: string,
  credential: Readonly<Record<string, string>>,
  opts: RenderCredentialTemplateOptions = {},
): string | null {
  const [unsupported] = unsupportedTemplateExpressions(template);
  if (unsupported !== undefined) {
    throw new Error(
      `unsupported template expression '${unsupported}' — only {$credential.<field>} renders`,
    );
  }
  const rendered = substituteCredentialRefs(template, credential);
  if (opts.emptyAs === "null") return rendered.length === 0 ? null : rendered;
  return rendered;
}

/** Each `{$credential.<field>}` → its value; a missing or inherited field renders empty. */
export function substituteCredentialRefs(
  template: string,
  credential: Readonly<Record<string, unknown>>,
): string {
  return template.replace(CREDENTIAL_REF, (_m, field: string) =>
    Object.prototype.hasOwnProperty.call(credential, field) ? String(credential[field]) : "",
  );
}

/** Field names referenced by `{$credential.<name>}` placeholders, in order, deduplicated. */
export function credentialTemplateRefs(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(CREDENTIAL_REF), (m) => m[1]!))];
}
