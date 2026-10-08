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
 * It also renders the connection's variables (§7.12), `{$variable.<name>}`.
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

import { VARIABLE_REF } from "./connection-variables.ts";

export const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;

const SINGLE_CREDENTIAL_REF = new RegExp(`^${CREDENTIAL_REF.source}$`);
const SINGLE_VARIABLE_REF = new RegExp(`^${VARIABLE_REF.source}$`);

/** Either reference: group 1 is a credential field, group 2 a variable name. */
export const TEMPLATE_REF = new RegExp(`${CREDENTIAL_REF.source}|${VARIABLE_REF.source}`, "g");

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

/** The embedded `{$…}` expressions of `template` that are not credential or variable references. */
export function unsupportedTemplateExpressions(template: string): string[] {
  return templateExpressions(template).filter(
    (e) => parseCredentialRef(e) === null && !SINGLE_VARIABLE_REF.test(e),
  );
}

export interface RenderCredentialTemplateOptions {
  /**
   * What an all-empty render resolves to. `"string"` returns `""`; `"null"`
   * returns `null`. Defaults to `"string"`.
   */
  emptyAs?: "string" | "null";
  /** The connection's variables, rendered for `{$variable.<name>}`. Defaults to none. */
  variables?: Readonly<Record<string, string>>;
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
      `unsupported template expression '${unsupported}' — only {$credential.<field>} and {$variable.<name>} render`,
    );
  }
  const rendered = substituteCredentialRefs(template, credential, opts.variables);
  if (opts.emptyAs === "null") return rendered.length === 0 ? null : rendered;
  return rendered;
}

/**
 * Each `{$credential.<field>}` and `{$variable.<name>}` → its value, in one pass; a missing or
 * inherited one renders empty.
 */
export function substituteCredentialRefs(
  template: string,
  credential: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>> = {},
): string {
  return template.replace(TEMPLATE_REF, (_m, field: string | undefined, name: string) => {
    const [bag, key] = field !== undefined ? [credential, field] : [variables, name];
    return Object.prototype.hasOwnProperty.call(bag, key) ? String(bag[key]) : "";
  });
}

/** Field names referenced by `{$credential.<name>}` placeholders, in order, deduplicated. */
export function credentialTemplateRefs(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(CREDENTIAL_REF), (m) => m[1]!))];
}
