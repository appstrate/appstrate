// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS `authorized_uris` rules — the SINGLE source of truth for the URL-pattern
 * grammar: parsing and canonicalising an entry, rendering its
 * `{$credential.<field>}` and `{$variable.<name>}` placeholders for one connection, the host-bound rule
 * (judged with the Public Suffix List at write and at run time), the URL
 * matcher and the compiled (URL, host:port) egress policy. Consumers import
 * this module directly.
 */

import { getDomain } from "tldts";
import {
  EXPECTED_HOST_VALUE,
  EXPECTED_URL_VALUE,
  HOST_LABEL,
  renderHostVariable,
  renderUrlVariable,
  VARIABLE_REF,
  variableRefs,
} from "./connection-variables.ts";
import {
  credentialTemplateRefs,
  substituteCredentialRefs,
  TEMPLATE_REF,
} from "./credential-template.ts";

/** A rendered value may only be a literal host label run or port digits, never dots alone. */
const AUTHORITY_VALUE = /^(?!\.+$)[A-Za-z0-9.-]+$/;

const URL_FORM_HEAD = new RegExp(`^(?:${TEMPLATE_REF.source})`);
const HAS_TEMPLATE_REF = new RegExp(TEMPLATE_REF.source);

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

// Both list sections: a private suffix (`github.io`) hands out subdomains like an ICANN one.
const PUBLIC_SUFFIX_LIST = { allowPrivateDomains: true, extractHostname: false } as const;

// Stands for what a host wildcard expands to, so the list's wildcard rules apply to it too.
const WILDCARD_PROBE = "afps-wildcard-probe";

// A loop, not `/\.+$/`: that regex backtracks quadratically on a host full of dots.
function normalisedHost(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") end--;
  return host.slice(0, end).toLowerCase();
}

/** The labels right of the last one holding a `*`. */
function wildcardLiteral(host: string): string {
  const dot = host.indexOf(".", host.lastIndexOf("*"));
  return dot === -1 ? "" : host.slice(dot + 1);
}

type EntryReading =
  | { kind: "url-form" }
  | Exclude<AuthorizedUriPattern, { kind: "url" }>
  | { kind: "url"; scheme: string; host: string; literal: string | null };

/** A template reads as one literal label; `literal` is `null` for a host without wildcard. */
function readEntry(pattern: string): EntryReading {
  if (parseUrlFormPattern(pattern)) return { kind: "url-form" };
  const parsed = parseAuthorizedUriPattern(pattern.replace(TEMPLATE_REF, "x"));
  if (parsed.kind !== "url") return parsed;
  const host = normalisedHost(parsed.host);
  const literal = host.includes("*") ? wildcardLiteral(host) : null;
  return { kind: "url", scheme: parsed.scheme, host, literal };
}

/** Whether `host`'s registrable domain lies inside the wildcard's literal part. */
function domainWithin(literal: string, host: string): boolean {
  if (literal === "") return false;
  const domain = getDomain(host, PUBLIC_SUFFIX_LIST);
  return domain !== null && (literal === domain || literal.endsWith(`.${domain}`));
}

/**
 * Whether an `authorized_uris` entry lets the caller pick the host: malformed, no literal
 * `scheme://`, an empty host, a wildcard in an IP-shaped host, or a wildcard not under a literal
 * registrable domain per the Public Suffix List (`*.co.uk`, `*.github.io`). Write-time half.
 */
export function isHostUnboundedUriPattern(pattern: string): boolean {
  const entry = readEntry(pattern);
  if (entry.kind === "url-form") return false;
  if (entry.kind === "path") return entry.pattern.includes("*");
  if (entry.kind !== "url" || entry.scheme.includes("*")) return true;
  if (entry.literal === null) return entry.host === "";
  const labels = entry.host.split(".");
  if (entry.host.startsWith("[") || WHATWG_IPV4_NUMBER.test(labels[labels.length - 1]!)) {
    return true;
  }
  return !domainWithin(entry.literal, `${WILDCARD_PROBE}.${entry.literal}`);
}

/**
 * Run-time half: an authority `*` spans dots, so `https://*.amazonaws.com/**` also matches hosts
 * under a deeper public suffix (`sqs.us-east-1.amazonaws.com`). True only when `targetHost`'s
 * registrable domain lies inside the entry's literal part; always true without a host wildcard.
 */
export function wildcardMatchStaysWithinBound(pattern: string, targetHost: string): boolean {
  const entry = readEntry(pattern);
  // Only ever asked of an entry that matched an absolute target: a path entry never does.
  if (entry.kind !== "url") return entry.kind === "url-form";
  if (entry.literal === null) return true;
  const target = normalisedHost(targetHost);
  return !target.startsWith("[") && domainWithin(entry.literal, target);
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
  return { uri: substituteCredentialRefs(pattern, fields) };
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

/**
 * AFPS URL allowlist matcher: a literal is exact equality, `*` one path segment, `**` any
 * substring in the path but never past the `/` that ends the authority. The pattern is read by
 * {@link parseAuthorizedUriPattern}, the parser the host-bound rule also judges (malformed: no
 * match); the target is WHATWG-normalised first, so `?`, `#` or userinfo cannot end its
 * authority, and an unparseable target matches nothing.
 */
export function matchesAuthorizedUriSpec(pattern: string, target: string): boolean {
  const normalized = canonicalUrl(target);
  const regex = compileAuthorizedUriPattern(pattern);
  return normalized !== undefined && regex !== null && regex.test(normalized);
}

/**
 * Whether an entry names the URL's host literally (no glob or template; port and a globbed scheme
 * aside): only then can an internal address behind it skip the SSRF gate, and only when the
 * operator of the network allows that host too (`fetchApiCall`'s `internalHost`).
 */
export function hostLiterallyAllowlisted(url: string, specs: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return specs.some((spec) => {
    const parsed = parseAuthorizedUriPattern(spec);
    if (parsed.kind !== "url") return false;
    const hostPart = parsed.host.toLowerCase();
    // A templated host (`{$credential.host}`) is connection-chosen, never a pin.
    return !hostPart.includes("*") && !hostPart.includes("{") && hostPart === host;
  });
}

/** Escape regex metacharacters, leaving the `*` wildcard chars intact. */
function escapeUriLiteral(part: string): string {
  return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile one URL component to a regex fragment. `crossSlash` controls
 * whether a `**` may span `/` (true for the path, false for the authority).
 * `*` never crosses a slash in either component.
 */
function compileUriComponent(part: string, crossSlash: boolean): string {
  const doubleStar = crossSlash ? ".*" : "[^/]*";
  // Match `**` before `*` (alternation is ordered + `**` is longer) so a
  // double-star is never mis-expanded as two single-stars.
  return escapeUriLiteral(part).replace(/\*\*|\*/g, (m) => (m === "**" ? doubleStar : "[^/]*"));
}

/** A scheme glob matches scheme characters only, so it cannot reach into a query. */
function compileUriScheme(scheme: string): string {
  return escapeUriLiteral(scheme.toLowerCase()).replace(/\*\*|\*/g, "[a-z0-9+.-]*");
}

/** The anchored regex of an `authorized_uris` entry; `null` for a malformed one. */
function compileAuthorizedUriPattern(pattern: string): RegExp | null {
  const parsed = parseAuthorizedUriPattern(pattern);
  switch (parsed.kind) {
    case "malformed":
      return null;
    case "path":
      return new RegExp("^" + compileUriComponent(parsed.pattern, true) + "$");
    case "any":
      return new RegExp("^" + compileUriScheme(parsed.scheme) + ".*$");
    case "url":
      return new RegExp(
        "^" +
          compileUriScheme(parsed.scheme) +
          compileUriComponent(parsed.authority, false) +
          compileUriComponent(parsed.rest, true) +
          "$",
      );
  }
}

/** A connection's rendered `authorized_uris`, compiled for URL and (host, port) checks (#1458). */
export interface EgressPolicy {
  allowsAuthority(host: string, port: number): boolean;
  allowsUrl(url: string): boolean;
}

const EGRESS_DEFAULT_PORTS: Readonly<Record<string, number>> = {
  https: 443,
  wss: 443,
  http: 80,
  ws: 80,
  ssh: 22,
  sftp: 22,
};

// Hostname / IPv4 only: `[`, `@`, `?`, `#` could smuggle an allowed suffix past `[^/]*`.
const EGRESS_HOST_RE = /^[a-z0-9_.-]+$/;

// WHATWG elides default ports, so only these suffixes name a port explicitly.
const EGRESS_EXPLICIT_PORT_RE = /:(?:\d+|\*\*?)$/;

export function compileEgressPolicy(input: {
  authorizedUris: readonly string[];
  allowAllUris: boolean;
}): EgressPolicy {
  if (input.allowAllUris) return { allowsAuthority: () => true, allowsUrl: () => true };
  const urlRegexes = input.authorizedUris.flatMap((p) => compileAuthorizedUriPattern(p) ?? []);
  let anyAuthority = false;
  const authorityRules: {
    regex: RegExp;
    explicitPort: boolean;
    defaultPort: number | undefined;
  }[] = [];
  for (const pattern of input.authorizedUris) {
    const parsed = parseAuthorizedUriPattern(pattern);
    // Scheme-less, malformed or scheme-globbed patterns name no transport: nothing at TCP level.
    if (parsed.kind === "path" || parsed.kind === "malformed" || parsed.scheme.includes("*")) {
      continue;
    }
    if (parsed.kind === "any") {
      anyAuthority = true;
      continue;
    }
    authorityRules.push({
      regex: new RegExp("^" + compileUriComponent(parsed.authority, false) + "$", "i"),
      explicitPort: EGRESS_EXPLICIT_PORT_RE.test(parsed.authority),
      defaultPort: EGRESS_DEFAULT_PORTS[parsed.scheme.slice(0, -3)],
    });
  }
  return {
    allowsUrl(url) {
      const normalized = canonicalUrl(url);
      return normalized !== undefined && urlRegexes.some((r) => r.test(normalized));
    },
    allowsAuthority(host, port) {
      const h = host.toLowerCase();
      if (!EGRESS_HOST_RE.test(h) || !Number.isInteger(port) || port < 1 || port > 65535) {
        return false;
      }
      if (anyAuthority) return true;
      // No explicit port = scheme default only, on the bare host (`[^/]*` can't span `:port`).
      return authorityRules.some((r) =>
        r.explicitPort ? r.regex.test(`${h}:${port}`) : r.defaultPort === port && r.regex.test(h),
      );
    },
  };
}
