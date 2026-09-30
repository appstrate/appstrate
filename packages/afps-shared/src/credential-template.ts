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

/** The `{{…}}` placeholder of the api_call grammar, which a credential template never renders. */
export const API_CALL_PLACEHOLDER = /\{\{[^{}]*\}\}/g;

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
  const unsupported =
    template.match(API_CALL_PLACEHOLDER)?.[0] ?? unsupportedTemplateExpressions(template)[0];
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
function substituteCredentialRefs(
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

/** A rendered value may only be a literal host label run or port digits, never dots alone. */
const AUTHORITY_VALUE = /^(?!\.+$)[A-Za-z0-9.-]+$/;

const URL_FORM_HEAD = new RegExp(`^${CREDENTIAL_REF.source}`);

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

/** `scheme://`, the scheme possibly globbed (`**://`). */
const URI_PATTERN_SCHEME = /^[a-zA-Z*][a-zA-Z0-9+.*-]*:\/\//;

/** Nothing an authority may hold that WHATWG would decode, fold, re-split or strip as userinfo. */
const MALFORMED_AUTHORITY = /[^\x21-\x7e]|[%\\@?#]/;

/**
 * An `authorized_uris` entry as both the host-bound rule and the matcher read it: `path` has no
 * `scheme://`, `any` is `scheme://**`, `malformed` matches nothing and bounds no host.
 */
export type AuthorizedUriPattern =
  | { kind: "path"; pattern: string }
  | { kind: "any"; scheme: string }
  | { kind: "url"; scheme: string; authority: string; host: string; rest: string }
  | { kind: "malformed" };

/** `url` re-serialised by WHATWG without userinfo or fragment; `undefined` if unparseable. */
export function canonicalUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

function splitAuthority(afterScheme: string): { authority: string; rest: string } {
  const slash = afterScheme.indexOf("/");
  return slash === -1
    ? { authority: afterScheme, rest: "" }
    : { authority: afterScheme.slice(0, slash), rest: afterScheme.slice(slash) };
}

/** A bracketed IPv6 literal, or what precedes the first `:` (a port, possibly globbed). */
function authorityHost(authority: string): string {
  if (!authority.startsWith("[")) return authority.split(":")[0]!;
  const close = authority.indexOf("]");
  return close === -1 ? authority : authority.slice(0, close + 1);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** {@link canonicalUrl} of a pattern, its wildcards masked through WHATWG; `undefined` if lost. */
function canonicalPattern(pattern: string): string | undefined {
  let n = 0;
  let single = "zzurisinglezz";
  let double = "zzuridoublezz";
  while (pattern.includes(single) || pattern.includes(double)) {
    n += 1;
    single = `zzurisingle${n}zz`;
    double = `zzuridouble${n}zz`;
  }
  const masked = pattern.replace(/\*\*|\*/g, (m) => (m === "**" ? double : single));
  const canonical = canonicalUrl(masked);
  if (
    canonical === undefined ||
    countOccurrences(canonical, single) !== countOccurrences(masked, single) ||
    countOccurrences(canonical, double) !== countOccurrences(masked, double)
  ) {
    return undefined;
  }
  return canonical.split(double).join("**").split(single).join("*");
}

/**
 * Parse an `authorized_uris` entry. Its authority (up to the first `/`) must be spelled as WHATWG
 * serialises it, case and a default port aside, else `malformed`; a pattern WHATWG cannot parse
 * (`host:*`) keeps its raw authority and path, which then match less, never more.
 */
export function parseAuthorizedUriPattern(pattern: string): AuthorizedUriPattern {
  const schemeMatch = URI_PATTERN_SCHEME.exec(pattern);
  if (!schemeMatch) return { kind: "path", pattern };
  const scheme = schemeMatch[0].toLowerCase();
  const raw = splitAuthority(pattern.slice(scheme.length));
  if (raw.authority === "**" && raw.rest === "") return { kind: "any", scheme };
  if (raw.authority === "" || MALFORMED_AUTHORITY.test(raw.authority)) return { kind: "malformed" };
  const canonical = canonicalPattern(pattern);
  if (canonical === undefined) {
    return { kind: "url", scheme, ...raw, host: authorityHost(raw.authority) };
  }
  const parts = splitAuthority(canonical.slice(scheme.length));
  const authority = parts.authority.toLowerCase();
  const rawAuthority = raw.authority.toLowerCase();
  if (authority !== rawAuthority && authority !== rawAuthority.replace(/:\d+$/, "")) {
    return { kind: "malformed" };
  }
  return { kind: "url", scheme, ...parts, host: authorityHost(parts.authority) };
}

/**
 * Whether an `authorized_uris` entry lets the caller pick the host, judged on its
 * {@link parseAuthorizedUriPattern} reading: malformed, no literal `scheme://`, an empty host, or
 * a wildcard in one of its last two labels (`https://*.com./**`). `*.co.uk` is not detected.
 */
export function isHostUnboundedUriPattern(pattern: string): boolean {
  if (parseUrlFormPattern(pattern)) return false;
  const parsed = parseAuthorizedUriPattern(pattern.replace(CREDENTIAL_REF, "x"));
  if (parsed.kind === "path") return parsed.pattern.includes("*");
  if (parsed.kind !== "url" || parsed.scheme.includes("*")) return true;
  const host = parsed.host.replace(/\.+$/, "");
  if (!host.includes("*")) return host === "";
  const labels = host.split(".");
  return labels.length < 3 || labels.slice(-2).some((label) => label.includes("*"));
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
  // A pattern is not a delivery template: anything but a checked field stays literal, narrowing it.
  return { uri: substituteCredentialRefs(pattern, fields) };
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
