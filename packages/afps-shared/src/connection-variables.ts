// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS §7.12 connection variables (`{$variable.<name>}`) and the URL templates that choose a
 * connection's upstream from them. A variable is not a secret: its value may be shown and logged.
 */

/** `value` without its trailing `/`s, in linear time: a `/\/+$/` regex backtracks on untrusted input. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** One `{$variable.<name>}` reference; group 1 is the name (`VARIABLE_NAME_REGEX`, Appendix B). */
export const VARIABLE_REF = /\{\$variable\.([a-z][a-z0-9_]*)\}/g;

/** Variable names referenced by `template`, in order, deduplicated. */
export function variableRefs(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(VARIABLE_REF), (m) => m[1]!))];
}

export function isVariableTemplate(value: unknown): value is string {
  return typeof value === "string" && value.includes("{$variable.");
}

export const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";

// URL_TEMPLATE_REGEX of `@afps-spec/schema`, split into its two forms.
const PLACEHOLDER = VARIABLE_REF.source;
const LAST_LABEL = "[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const SEGMENT = "(?!\\.\\.?(?:\\/|$))[A-Za-z0-9._~!$&'()+,;=:@-]+";
const PATH = `((?:\\/${SEGMENT})*\\/?)`;
const URL_FORM = new RegExp(`^${PLACEHOLDER}${PATH}$`);
const HOST_FORM = new RegExp(
  `^https:\\/\\/${PLACEHOLDER}((?:\\.${HOST_LABEL})*\\.${LAST_LABEL})${PATH}$`,
);

type UrlTemplate =
  | { form: "url"; name: string; path: string }
  | { form: "host"; name: string; domain: string; path: string };

/** A URL template split into its form, variable and literal parts; `null` for anything else. */
export function parseUrlTemplate(template: string): UrlTemplate | null {
  const url = URL_FORM.exec(template);
  if (url) return { form: "url", name: url[1]!, path: url[2]! };
  const host = HOST_FORM.exec(template);
  if (host) return { form: "host", name: host[1]!, domain: host[2]!, path: host[3]! };
  return null;
}

/** Whether the authority of `value` carries userinfo, even empty (`https://@host`). */
function hasUserinfo(value: string): boolean {
  const afterScheme = value.slice(value.indexOf(":") + 1).replace(/^[/\\]*/, "");
  return afterScheme.split(/[/\\]/, 1)[0]!.includes("@");
}

/**
 * A URL-form value: absolute `http`/`https` with a host, without userinfo, query, fragment (even
 * an empty `?` or `#`) or `*`. `http` is left to the egress check, which knows the trusted hosts.
 */
function parseUrlVariableValue(value: unknown): URL | null {
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

// RFC 1035 §2.3.4: labels of at most 63 characters, a name of at most 253.
const VALUE_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST_VALUE = new RegExp(`^${VALUE_LABEL}(?:\\.${VALUE_LABEL})*$`);
const MAX_HOST_LENGTH = 253;

/** The connection's value of `name`; an inherited property is no value. */
function variableValue(variables: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
}

/** The URL-form variable `name`, then `path` by concatenation, never relative resolution. */
export function renderUrlVariable(
  variables: Readonly<Record<string, unknown>>,
  name: string,
  path: string,
): string | null {
  const url = parseUrlVariableValue(variableValue(variables, name));
  if (!url) return null;
  return path === "" ? url.href : url.origin + stripTrailingSlashes(url.pathname) + path;
}

/** The host-form variable `name`, lowercased, followed by `domain`; `null` past 253 characters. */
export function renderHostVariable(
  variables: Readonly<Record<string, unknown>>,
  name: string,
  domain: string,
): string | null {
  const label = variableValue(variables, name);
  if (typeof label !== "string" || !HOST_VALUE.test(label)) return null;
  const host = label.toLowerCase() + domain;
  return host.length > MAX_HOST_LENGTH ? null : host;
}

/** A URL-valued field for one connection; `null` for a template or value its form refuses. */
export function renderUrlTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string | null {
  if (!template.includes("{$")) return template;
  const parsed = parseUrlTemplate(template);
  if (!parsed) return null;
  if (parsed.form === "url") return renderUrlVariable(variables, parsed.name, parsed.path);
  const host = renderHostVariable(variables, parsed.name, parsed.domain);
  return host === null ? null : `https://${host}${parsed.path}`;
}

export const EXPECTED_URL_VALUE =
  "an absolute http:// or https:// URL without userinfo, query string, fragment or '*'";
export const EXPECTED_HOST_VALUE =
  "a host name: '.'-separated labels of 1 to 63 letters, digits and '-', none starting or ending with '-'";

/** The variables to blame when {@link renderUrlTemplate} renders `null`, with the form each must take. */
export function unrenderableUrlTemplateVariables(
  template: string,
  variables: Readonly<Record<string, string>>,
): { name: string; expected: string }[] {
  if (renderUrlTemplate(template, variables) !== null) return [];
  const parsed = parseUrlTemplate(template);
  const expected = parsed?.form === "host" ? EXPECTED_HOST_VALUE : EXPECTED_URL_VALUE;
  return (parsed ? [parsed.name] : variableRefs(template)).map((name) => ({ name, expected }));
}
