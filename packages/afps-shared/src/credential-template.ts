// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `{$credential.<field>}` value-template renderer — the SINGLE
 * source of truth, re-exported by `@appstrate/core/credential-template`.
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
  const rendered = template.replace(CREDENTIAL_REF, (_m, field: string) => credential[field] ?? "");
  if (opts.emptyAs === "null") return rendered.length === 0 ? null : rendered;
  return rendered;
}
