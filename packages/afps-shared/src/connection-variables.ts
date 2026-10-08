// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS §7.12 connection variables: the `{$variable.<name>}` references of a manifest and the URL
 * templates (`source.remote.url`, an oauth2 `issuer`, `connect.login.request.url`) that choose a
 * connection's upstream from them. A variable is not a secret: its value may be displayed and
 * logged. The value templates and `authorized_uris` entries that reference variables render in
 * `./credential-template.ts`, with the value rules exported here.
 */

/** One `{$variable.<name>}` reference; group 1 is the name (`VARIABLE_NAME_REGEX`, Appendix B). */
export const VARIABLE_REF = /\{\$variable\.([a-z][a-z0-9_]*)\}/g;

/** Variable names referenced by `template`, in order, deduplicated. */
export function variableRefs(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(VARIABLE_REF), (m) => m[1]!))];
}

/** Whether `value` references a connection variable, so it renders per connection. */
export function isVariableTemplate(value: unknown): value is string {
  return typeof value === "string" && value.includes("{$variable.");
}

// URL_TEMPLATE_REGEX of `@afps-spec/schema`, split into its two forms.
const PLACEHOLDER = "\\{\\$variable\\.([a-z][a-z0-9_]*)\\}";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const LAST_LABEL = "[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const SEGMENT = "(?!\\.\\.?(?:\\/|$))[A-Za-z0-9._~!$&'()+,;=:@-]+";
const PATH = `((?:\\/${SEGMENT})*\\/?)`;
const URL_FORM = new RegExp(`^${PLACEHOLDER}${PATH}$`);
const HOST_FORM = new RegExp(
  `^https:\\/\\/${PLACEHOLDER}((?:\\.${LABEL})*\\.${LAST_LABEL})${PATH}$`,
);

type UrlTemplate =
  | { form: "url"; name: string; path: string }
  | { form: "host"; name: string; domain: string; path: string };

function parseUrlTemplate(template: string): UrlTemplate | null {
  const url = URL_FORM.exec(template);
  if (url) return { form: "url", name: url[1]!, path: url[2]! };
  const host = HOST_FORM.exec(template);
  if (host) return { form: "host", name: host[1]!, domain: host[2]!, path: host[3]! };
  return null;
}

/** Whether `template` is a §7.12 URL template (the URL form or the host form). */
export function isUrlTemplate(template: string): boolean {
  return parseUrlTemplate(template) !== null;
}

/** Whether the authority of `value` carries userinfo, even empty (`https://@host`). */
function hasUserinfo(value: string): boolean {
  const afterScheme = value.slice(value.indexOf(":") + 1).replace(/^[/\\]*/, "");
  return afterScheme.split(/[/\\]/, 1)[0]!.includes("@");
}

/**
 * A URL-form variable value (§7.12): an absolute `http`/`https` URL with a host, without userinfo,
 * query, fragment (an empty `?` or `#` included) or `*`. `https`-only is the egress check's: it alone
 * knows the hosts an operator trusts over `http`.
 */
export function parseUrlVariableValue(value: unknown): URL | null {
  if (typeof value !== "string" || /[?#*]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password || hasUserinfo(value)) return null;
  return url;
}

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST_VALUE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/** Longest host name (RFC 1035 §2.3.4, without the root label's dot). */
export const MAX_HOST_LENGTH = 253;

/**
 * A host-form variable value (§7.12): `.`-separated labels of 1 to 63 letters, digits and `-`,
 * none starting or ending with `-`, lowercased. `null` otherwise.
 */
export function hostVariableValue(value: unknown): string | null {
  return typeof value === "string" && HOST_VALUE.test(value) ? value.toLowerCase() : null;
}

/** The connection's value of `name`; an inherited property is no value. */
function variableValue(variables: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
}

/**
 * Render a URL-valued field for one connection (§7.12) by substitution and concatenation, never
 * by relative resolution. A value without any `{$…}` is a literal URL and renders as itself; a
 * template outside the URL and host forms, or a value its form refuses, renders `null`.
 */
export function renderUrlTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string | null {
  if (!template.includes("{$")) return template;
  const parsed = parseUrlTemplate(template);
  if (!parsed) return null;
  const value = variableValue(variables, parsed.name);
  if (parsed.form === "url") {
    const url = parseUrlVariableValue(value);
    if (!url) return null;
    if (parsed.path === "") return url.href;
    return url.origin + url.pathname.replace(/\/+$/, "") + parsed.path;
  }
  const label = hostVariableValue(value);
  if (label === null) return null;
  const host = label + parsed.domain;
  return host.length > MAX_HOST_LENGTH ? null : `https://${host}${parsed.path}`;
}

/** The variables to blame when {@link renderUrlTemplate} renders `null`; `[]` when it renders. */
export function unrenderableUrlTemplateVariables(
  template: string,
  variables: Readonly<Record<string, string>>,
): string[] {
  if (renderUrlTemplate(template, variables) !== null) return [];
  const parsed = parseUrlTemplate(template);
  return parsed ? [parsed.name] : variableRefs(template);
}
