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

/** Field names referenced by `{$credential.<name>}` placeholders, in order, deduplicated. */
export function credentialTemplateRefs(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(CREDENTIAL_REF), (m) => m[1]!))];
}

/** A rendered value may only be a literal host label run or port digits, never dots alone. */
const AUTHORITY_VALUE = /^(?!\.+$)[A-Za-z0-9.-]+$/;

const URL_FORM_HEAD = /^\{\$credential\.([A-Za-z0-9_]+)\}/;

/**
 * Split a URL-form pattern (#1627): exactly one placeholder at index 0, followed by nothing or
 * a `/` suffix without placeholders. `null` for any other pattern.
 */
export function parseUrlFormPattern(pattern: string): { field: string; suffix: string } | null {
  const head = URL_FORM_HEAD.exec(pattern);
  if (!head) return null;
  const suffix = pattern.slice(head[0].length);
  if (suffix !== "" && (!suffix.startsWith("/") || credentialTemplateRefs(suffix).length > 0)) {
    return null;
  }
  return { field: head[1]!, suffix };
}

/** Absolute http(s) URL, no userinfo/query/fragment/`*`, as origin + path (a root path drops). */
function renderUrlValue(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  return url.pathname === "/" ? url.origin : url.origin + url.pathname;
}

/**
 * Render `authorized_uris` for one connection (#1458). A templated pattern is DROPPED when a
 * referenced field fails {@link AUTHORITY_VALUE} (or, for the URL form, {@link renderUrlValue}),
 * so a value cannot add a wildcard, a separator or another host. Import validation confines
 * placeholders to the host and port, or to the head of a URL-form pattern.
 */
export function renderAuthorizedUris(
  patterns: readonly string[],
  fields: Readonly<Record<string, string>>,
): string[] {
  return patterns.flatMap((pattern) => {
    const urlForm = parseUrlFormPattern(pattern);
    if (urlForm) {
      const base = renderUrlValue(fields[urlForm.field]);
      if (base === null) return [];
      // A suffix brings its own `/`; a bare entry keeps the value's exact path (`…/hook/`).
      return [urlForm.suffix ? base.replace(/\/$/, "") + urlForm.suffix : base];
    }
    const refs = credentialTemplateRefs(pattern);
    const renderable = refs.every((ref) => {
      const value = fields[ref];
      return typeof value === "string" && AUTHORITY_VALUE.test(value);
    });
    return renderable ? [renderCredentialTemplate(pattern, fields)] : [];
  });
}
