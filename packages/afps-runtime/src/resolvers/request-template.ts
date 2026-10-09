// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * `{{name}}` substitution into an HTTP request, each value encoded for the place it takes. Shared
 * by the two paths that send a user's login inputs: the declarative `connect.login` engine
 * (`@appstrate/connect`) and the sidecar's `connect.tool` login substitution.
 *
 * What it guarantees: a value adds no form parameter to a form body, no member to a JSON body, no
 * element to an XML body, no part to a multipart body, no path segment, query parameter or
 * fragment to a URL past its leading base, no header line, and no cookie to a `Cookie` header.
 * What it does not: a value inside a multipart part's own headers (a `Content-Disposition`
 * parameter) is not escaped, and a body of any other media type takes the value as is — the
 * template's author keeps a placeholder out of those places.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { normalizeMime } from "@appstrate/afps-shared/mime";
import { placeholderAt, substituteVars, type PlaceholderEncoder } from "./template-vars.ts";

/** What every refusal says: the field, never the value. */
const CANNOT_CARRY = "contains a character this request cannot carry where it is placed";

/** An input the request cannot carry where its placeholder sits. Names the field, never the value. */
export class UnencodableInputError extends Error {
  constructor(
    readonly field: string,
    problem: string,
  ) {
    super(`input '${field}' ${problem}`);
    this.name = "UnencodableInputError";
  }
}

const asIs: PlaceholderEncoder = (value) => value;

/**
 * The inputs that land in the authority of URL template `template` — every placeholder before its
 * first literal `/`, `?` or `#` after `scheme://`: a URL refused for its host is theirs.
 */
export function urlAuthorityInputs(template: string): string[] {
  let i = /^[a-z][a-z0-9+.-]*:\/\//i.exec(template)?.[0].length ?? 0;
  const keys: string[] = [];
  while (i < template.length && !"/?#".includes(template[i]!)) {
    const placeholder = placeholderAt(template, i);
    if (placeholder) keys.push(placeholder.key);
    i += placeholder?.length ?? 1;
  }
  return keys;
}

/**
 * URL: a placeholder that starts the template is a base URL, spliced as is — the caller's URL gate
 * judges the result. Every other value is percent-encoded as one component, wherever it sits: a
 * value after a literal host or after the base (`https://h.com{{path}}`, `{{base}}{{path}}`), a
 * port or userinfo, a path segment, a query component, a fragment. A `/` the URL needs is written
 * in the template.
 */
const urlValue: PlaceholderEncoder = (value, _key, offset) =>
  offset === 0 ? value : encodeURIComponent(value);

/** `application/x-www-form-urlencoded` component, per the WHATWG serializer (space → `+`). */
const formComponent: PlaceholderEncoder = (value) =>
  new URLSearchParams([["", value]]).toString().slice(1);

/**
 * JSON: inside a string literal a value is escaped. Anywhere else it is one whole JSON value of its
 * own type: a string is a JSON string, whatever it spells, and a typed value is its JSON. A value's
 * type never depends on its text — the caller types an input (from the schema it was submitted
 * against) before substituting it.
 */
function jsonEncoder(
  template: string,
  inputs: Readonly<Record<string, unknown>>,
): PlaceholderEncoder {
  const inString: boolean[] = [];
  let open = false;
  let escaped = false;
  for (let i = 0; i < template.length; i++) {
    inString[i] = open;
    const ch = template[i];
    if (escaped) escaped = false;
    else if (open && ch === "\\") escaped = true;
    else if (ch === '"') open = !open;
  }
  return (value, key, offset) => {
    if (inString[offset]) return JSON.stringify(value).slice(1, -1);
    const typed = inputs[key];
    return (typeof typed === "string" ? undefined : JSON.stringify(typed)) ?? JSON.stringify(value);
  };
}

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** XML: a value is entity-escaped, except in a CDATA section, where only `]]>` is split. */
function xmlEncoder(template: string): PlaceholderEncoder {
  const sections = [...template.matchAll(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  return (value, _key, offset) =>
    sections.some(([start, end]) => offset > start && offset < end)
      ? value.replaceAll("]]>", "]]]]><![CDATA[>")
      : value.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]!);
}

const JSON_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "text/json",
  "application/x-json",
]);

/** multipart: a value cannot carry CR or LF, which a part delimiter starts with. */
const multipartValue: PlaceholderEncoder = (value, key) => {
  if (/[\r\n]/.test(value)) throw new UnencodableInputError(key, CANNOT_CARRY);
  return value;
};

/** The body's encoding, read from its media type; a type with no grammar here is as is. */
function bodyEncoder(
  template: string,
  contentType: string | undefined,
  inputs: Readonly<Record<string, unknown>>,
): PlaceholderEncoder {
  const mime = normalizeMime(contentType);
  if (mime === "application/x-www-form-urlencoded") return formComponent;
  if (mime.startsWith("multipart/")) return multipartValue;
  if (JSON_MEDIA_TYPES.has(mime) || mime.endsWith("+json")) return jsonEncoder(template, inputs);
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) {
    return xmlEncoder(template);
  }
  return asIs;
}

/** RFC 6265 `cookie-octet`: a cookie value without `;`, `,`, space, `"`, `\` or a CTL. */
const COOKIE_OCTETS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/**
 * A header value is spliced as is; one that is not an HTTP field value (CR, LF, NUL, a character
 * above U+00FF) is refused, and in a `Cookie` header one outside `cookie-octet` too.
 */
function headerEncoder(name: string): PlaceholderEncoder {
  const cookie = name.toLowerCase() === "cookie";
  return (value, key) => {
    if (!isHttpFieldValue(value) || (cookie && !COOKIE_OCTETS.test(value))) {
      throw new UnencodableInputError(key, CANNOT_CARRY);
    }
    return value;
  };
}

/**
 * `request` with every `{{name}}` that `inputs` owns replaced by its encoded value; any other
 * placeholder is left intact (callers refuse those first, with `unresolvedPlaceholders`). The body
 * is encoded by the media type of its `Content-Type` header, else `contentType`. A value that is
 * not a string is its JSON text, except in a bare JSON position, where it is that JSON value.
 * Throws {@link UnencodableInputError}.
 */
export function substituteRequest<B extends string | null | undefined>(
  request: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: B;
    contentType?: string;
  },
  inputs: Readonly<Record<string, unknown>>,
): { url: string; headers: Record<string, string>; body: B } {
  const text: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    text[key] = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  }
  const render = (template: string, encode: PlaceholderEncoder) =>
    substituteVars(template, text, {
      keepUnresolved: true,
      encode: (value, key, offset) => {
        if (!value.isWellFormed()) throw new UnencodableInputError(key, CANNOT_CARRY);
        return encode(value, key, offset);
      },
    });
  const contentType = headerNamed(request.headers, "content-type") ?? request.contentType;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = render(value, headerEncoder(name));
  }
  const body =
    typeof request.body === "string"
      ? render(request.body, bodyEncoder(request.body, contentType, inputs))
      : request.body;
  return { url: render(request.url, urlValue), headers, body: body as B };
}

/** The value of header `name` (lower case), whatever the case it is written in. */
export function headerNamed(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}
