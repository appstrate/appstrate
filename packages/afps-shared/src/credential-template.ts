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

import {
  EXPECTED_HOST_VALUE,
  EXPECTED_URL_VALUE,
  HOST_LABEL,
  renderHostVariable,
  renderUrlVariable,
  VARIABLE_REF,
  variableRefs,
} from "./connection-variables.ts";

export const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;

const SINGLE_CREDENTIAL_REF = new RegExp(`^${CREDENTIAL_REF.source}$`);
const SINGLE_VARIABLE_REF = new RegExp(`^${VARIABLE_REF.source}$`);

/** Either reference: group 1 is a credential field, group 2 a variable name. */
const TEMPLATE_REF = new RegExp(`${CREDENTIAL_REF.source}|${VARIABLE_REF.source}`, "g");
const HAS_TEMPLATE_REF = new RegExp(TEMPLATE_REF.source);

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
  const rendered = substituteRefs(template, credential, opts.variables ?? {});
  if (opts.emptyAs === "null") return rendered.length === 0 ? null : rendered;
  return rendered;
}

/** Each reference → its value, in one pass; a missing or inherited one renders empty. */
function substituteRefs(
  template: string,
  credential: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
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

/** A rendered value may only be a literal host label run or port digits, never dots alone. */
const AUTHORITY_VALUE = /^(?!\.+$)[A-Za-z0-9.-]+$/;

const URL_FORM_HEAD = new RegExp(`^(?:${TEMPLATE_REF.source})`);

export type TemplateRoot = "credential" | "variable";

/**
 * Split a URL-form pattern (#1627): exactly one placeholder at index 0, followed by nothing or
 * a `/` suffix without placeholders. `null` for any other pattern.
 */
export function parseUrlFormPattern(
  pattern: string,
): { root: TemplateRoot; field: string; suffix: string } | null {
  const head = URL_FORM_HEAD.exec(pattern);
  if (!head) return null;
  const suffix = pattern.slice(head[0].length);
  if (suffix !== "" && (!suffix.startsWith("/") || HAS_TEMPLATE_REF.test(suffix))) return null;
  return head[1] !== undefined
    ? { root: "credential", field: head[1], suffix }
    : { root: "variable", field: head[2]!, suffix };
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

/** A last label that makes WHATWG parse the host as IPv4 (its "ends in a number" check). */
const WHATWG_IPV4_NUMBER = /^(?:\d+|0x[0-9a-f]*)$/i;

/**
 * Whether an `authorized_uris` entry lets the caller pick the host, judged on its
 * {@link parseAuthorizedUriPattern} reading: malformed, no literal `scheme://`, an empty host, or
 * a wildcard in one of its last two labels (`https://*.com./**`) or anywhere in an IP literal or
 * IPv4-shaped host (last label numeric: `https://*.0.1/**` matches `0x2d210001`). `*.co.uk` is not
 * detected.
 */
export function isHostUnboundedUriPattern(pattern: string): boolean {
  if (parseUrlFormPattern(pattern)) return false;
  const parsed = parseAuthorizedUriPattern(pattern.replace(TEMPLATE_REF, "x"));
  if (parsed.kind === "path") return parsed.pattern.includes("*");
  if (parsed.kind !== "url" || parsed.scheme.includes("*")) return true;
  const host = parsed.host.replace(/\.+$/, "");
  if (!host.includes("*")) return host === "";
  const labels = host.split(".");
  return (
    host.startsWith("[") ||
    WHATWG_IPV4_NUMBER.test(labels[labels.length - 1]!) ||
    labels.length < 3 ||
    labels.slice(-2).some((label) => label.includes("*"))
  );
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

/** A field that keeps its `authorized_uris` entry from rendering, and the form it must take. */
export interface UnrenderableUriField {
  root: TemplateRoot;
  field: string;
  expected: string;
}

/** §7.9 authority entry whose host starts with a variable, then literal labels and a port. */
const VARIABLE_AUTHORITY_ENTRY = new RegExp(
  `^([A-Za-z][A-Za-z0-9+.-]*:\\/\\/)${VARIABLE_REF.source}((?:\\.${HOST_LABEL})*)((?::[0-9]+)?(?:\\/[^{}]*)?)$`,
);

function renderVariableEntry(
  pattern: string,
  variables: Readonly<Record<string, unknown>>,
  urlForm: { field: string; suffix: string } | null,
): { uri: string } | UnrenderableUriField {
  if (urlForm) {
    const uri = renderUrlVariable(variables, urlForm.field, urlForm.suffix);
    return uri === null
      ? { root: "variable", field: urlForm.field, expected: EXPECTED_URL_VALUE }
      : { uri };
  }
  const entry = VARIABLE_AUTHORITY_ENTRY.exec(pattern);
  const host = entry && renderHostVariable(variables, entry[2]!, entry[3]!);
  if (!entry || host === null) {
    const field = entry?.[2] ?? variableRefs(pattern)[0]!;
    return { root: "variable", field, expected: EXPECTED_HOST_VALUE };
  }
  return { uri: entry[1]! + host + entry[4]! };
}

function renderPattern(
  pattern: string,
  fields: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
): { uri: string } | UnrenderableUriField {
  const urlForm = parseUrlFormPattern(pattern);
  if (urlForm?.root === "variable" || (!urlForm && variableRefs(pattern).length > 0)) {
    return renderVariableEntry(pattern, variables, urlForm);
  }
  if (urlForm) {
    const bare = urlForm.suffix === "";
    const base = renderUrlValue(fields[urlForm.field], bare);
    if (base === null) {
      return {
        root: "credential",
        field: urlForm.field,
        expected: bare ? EXPECTED_URL : EXPECTED_URL_VALUE,
      };
    }
    // A suffix brings its own `/`; a bare entry keeps the value's exact path (`…/hook/`).
    return { uri: bare ? base : base.replace(/\/$/, "") + urlForm.suffix };
  }
  const bad = credentialTemplateRefs(pattern).find((ref) => {
    const value = fields[ref];
    return typeof value !== "string" || !AUTHORITY_VALUE.test(value);
  });
  if (bad !== undefined) return { root: "credential", field: bad, expected: EXPECTED_AUTHORITY };
  // A pattern is not a delivery template: anything but a checked field stays literal, narrowing it.
  return { uri: substituteRefs(pattern, fields, {}) };
}

/**
 * Render `authorized_uris` for one connection (#1458). A templated pattern is DROPPED when a
 * referenced field fails {@link AUTHORITY_VALUE} (or, for the URL form, {@link renderUrlValue}),
 * so a value cannot add a wildcard, a separator or another host. Import validation confines
 * placeholders to the host and port, or to the head of a URL-form pattern. A variable must pass
 * the §7.12 value rule of its form.
 */
export function renderAuthorizedUris(
  patterns: readonly string[],
  fields: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, string>> = {},
): string[] {
  return patterns.flatMap((pattern) => {
    const rendered = renderPattern(pattern, fields, variables);
    return "uri" in rendered ? [rendered.uri] : [];
  });
}

/**
 * The fields and variables whose value would make {@link renderAuthorizedUris} drop an entry,
 * so a connection can be refused when it is written rather than on every later call (#1627).
 */
export function unrenderableAuthorizedUriFields(
  patterns: readonly string[],
  fields: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>> = {},
): UnrenderableUriField[] {
  const byRef = new Map<string, UnrenderableUriField>();
  for (const pattern of patterns) {
    const rendered = renderPattern(pattern, fields, variables);
    if ("uri" in rendered) continue;
    const key = `${rendered.root}.${rendered.field}`;
    if (!byRef.has(key)) byRef.set(key, rendered);
  }
  return [...byRef.values()];
}
