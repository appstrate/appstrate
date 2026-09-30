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

/**
 * Absolute http(s) URL, no userinfo/`#`/`*`/empty `?`, as origin + path (a root path drops). A
 * query is kept only for a bare entry (`allowQuery`), which is an exact match it cannot widen.
 */
function renderUrlValue(value: unknown, allowQuery: boolean): string | null {
  if (typeof value !== "string" || value.includes("*") || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  // An empty `?` vanishes from `url.search`, but a call to the stored URL keeps it: never a match.
  if (value.includes("?") && !url.search) return null;
  if (url.search && !allowQuery) return null;
  const path = url.pathname === "/" && !url.search ? "" : url.pathname;
  return url.origin + path + url.search;
}

const EXPECTED_AUTHORITY = "a host name or port (letters, digits, '.' and '-' only)";
const EXPECTED_URL =
  "an absolute http:// or https:// URL without userinfo, fragment ('#'), empty '?' or '*'";
const EXPECTED_URL_NO_QUERY =
  "an absolute http:// or https:// URL without userinfo, query string, fragment or '*'";

/** A field that keeps its `authorized_uris` entry from rendering, and the form it must take. */
export interface UnrenderableUriField {
  field: string;
  expected: string;
}

function renderPattern(
  pattern: string,
  fields: Readonly<Record<string, unknown>>,
): { uri: string } | UnrenderableUriField {
  const urlForm = parseUrlFormPattern(pattern);
  if (urlForm) {
    const bare = urlForm.suffix === "";
    const base = renderUrlValue(fields[urlForm.field], bare);
    if (base === null) {
      return { field: urlForm.field, expected: bare ? EXPECTED_URL : EXPECTED_URL_NO_QUERY };
    }
    // A suffix brings its own `/`; a bare entry keeps the value's exact path (`…/hook/`).
    return { uri: bare ? base : base.replace(/\/$/, "") + urlForm.suffix };
  }
  const bad = credentialTemplateRefs(pattern).find((ref) => {
    const value = fields[ref];
    return typeof value !== "string" || !AUTHORITY_VALUE.test(value);
  });
  if (bad !== undefined) return { field: bad, expected: EXPECTED_AUTHORITY };
  // Every referenced value was just checked to be a string.
  return { uri: renderCredentialTemplate(pattern, fields as Readonly<Record<string, string>>) };
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
    const rendered = renderPattern(pattern, fields);
    return "uri" in rendered ? [rendered.uri] : [];
  });
}

/**
 * The fields whose value would make {@link renderAuthorizedUris} drop an entry, once per field,
 * so a connection can be refused when it is written rather than on every later call (#1627).
 */
export function unrenderableAuthorizedUriFields(
  patterns: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): UnrenderableUriField[] {
  const byField = new Map<string, UnrenderableUriField>();
  for (const pattern of patterns) {
    const rendered = renderPattern(pattern, fields);
    if (!("uri" in rendered) && !byField.has(rendered.field)) byField.set(rendered.field, rendered);
  }
  return [...byField.values()];
}
