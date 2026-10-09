// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * `{{name}}` substitution into an HTTP request, each value encoded for its place so it cannot change
 * the request's structure (AFPS §7.7). Shared by the declarative `connect.login` engine and the
 * sidecar's `connect.tool` login. Not escaped: a multipart part's own headers, an unknown media type.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { normalizeMime } from "@appstrate/afps-shared/mime";
import { substituteVars, type PlaceholderEncoder } from "./template-vars.ts";

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

/** URL: a leading placeholder is a base URL, as is (the caller gates it); any other is one component. */
const urlValue: PlaceholderEncoder = (value, _key, offset) =>
  offset === 0 ? value : encodeURIComponent(value);

/** One WHATWG `application/x-www-form-urlencoded` component. */
const formComponent: PlaceholderEncoder = (value) =>
  new URLSearchParams([["", value]]).toString().slice(1);

/** JSON: escaped inside a string literal; elsewhere one JSON value of the input's own type. */
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

/** multipart: no CR or LF, which a part delimiter starts with. */
const multipartValue: PlaceholderEncoder = (value, key) => {
  if (/[\r\n]/.test(value)) throw new UnencodableInputError(key, CANNOT_CARRY);
  return value;
};

/** By media type; one with no grammar here is as is. */
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

/** Header: as is, if an HTTP field value (and, in `Cookie`, a `cookie-octet` string). */
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
 * `request` with each `{{name}}` of `inputs` encoded in place (others left intact). The body's media
 * type is its `Content-Type` header's, else `contentType`. Throws {@link UnencodableInputError}.
 */
export function substituteRequest<B extends string | null | undefined>(
  request: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: B;
    contentType?: string;
  },
  inputs: Readonly<Record<string, unknown>>,
): { url: string; headers: Record<string, string>; body: B extends string ? string : B } {
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
  return {
    url: render(request.url, urlValue),
    headers,
    body: body as B extends string ? string : B,
  };
}

/** The value of header `name` (lower case), whatever its case. */
export function headerNamed(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}
