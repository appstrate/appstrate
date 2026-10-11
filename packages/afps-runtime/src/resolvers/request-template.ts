// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * `{{name}}` substitution into an HTTP request, each value encoded for its place so it cannot change
 * the request's structure (AFPS §7.7). Shared by every `api_call` path, the declarative
 * `connect.login` engine and the sidecar's `connect.tool` login. A body is substituted only under a
 * media type it has an encoder for.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { normalizeMime } from "@appstrate/afps-shared/mime";
import { referencesField, substituteVars, type PlaceholderEncoder } from "./template-vars.ts";

const CANNOT_CARRY = "contains a character this request cannot carry where it is placed";

/** A value the request cannot carry where its placeholder sits. Names the placeholder, never the value. */
export class UnencodableInputError extends Error {
  constructor(
    readonly field: string,
    problem: string,
  ) {
    super(`{{${field}}} ${problem}`);
    this.name = "UnencodableInputError";
  }
}

/** A request no value can be substituted into as written. Names a header or a media type, never a value. */
export class RequestTemplateError extends Error {
  constructor(
    readonly part: "headers" | "body",
    message: string,
  ) {
    super(message);
    this.name = "RequestTemplateError";
  }
}

const asIs: PlaceholderEncoder = (value) => value;

/** URL: a leading placeholder is a base URL, as is (the caller gates it); any other is one component. */
const urlComponent: PlaceholderEncoder = (value, _key, offset) =>
  offset === 0 ? value : encodeURIComponent(value);

const EMPTY_OR_DOT_SEGMENT = /^(?:\.|%2e){0,2}$/i;

/** Refuses a path segment rendered empty, `.` or `..`, which percent-encoding does not neutralise. */
function checkPathSegments(
  template: string,
  render: (segment: string, encode: PlaceholderEncoder) => string,
): void {
  const beforeQuery = template.split(/[?#]/, 1)[0]!;
  const authority = /^[a-z][a-z\d+.-]*:\/\/[^/]*/i.exec(beforeQuery)?.[0].length ?? 0;
  for (const segment of beforeQuery.slice(authority).split("/").slice(1)) {
    let first: string | undefined;
    const rendered = render(segment, (value, key) => {
      first ??= key;
      return encodeURIComponent(value);
    });
    if (first !== undefined && EMPTY_OR_DOT_SEGMENT.test(rendered)) {
      throw new UnencodableInputError(
        first,
        "renders a URL path segment that is empty or a dot segment",
      );
    }
  }
}

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

/** XML: a value is entity-escaped, except in a CDATA section (none opens in a comment), where only `]]>` is split. */
function xmlEncoder(template: string): PlaceholderEncoder {
  const sections = [...template.matchAll(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g)]
    .filter((m) => m[0].startsWith("<![CDATA["))
    .map((m) => [m.index, m.index + m[0].length] as const);
  return (value, _key, offset) =>
    sections.some(([start, end]) => offset > start && offset < end)
      ? value.replaceAll("]]>", "]]]]><![CDATA[>")
      : value.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]!);
}

const JSON_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "text/json",
  "application/x-json",
  "application/x-ndjson",
]);

/** multipart: nothing that ends a part (CR, LF, the delimiter) or, in its headers, a quoted parameter. */
function multipartEncoder(template: string, contentType: string): PlaceholderEncoder | null {
  const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i
    .exec(contentType)
    ?.slice(1)
    .find(Boolean);
  if (boundary === undefined) return null;
  const delimiter = `--${boundary}`;
  const headerLines: Array<readonly [number, number]> = [];
  let inHeaders = false;
  let start = 0;
  for (const line of template.split("\n")) {
    if (line.startsWith(delimiter)) inHeaders = true;
    else if (line === "" || line === "\r") inHeaders = false;
    if (inHeaders) headerLines.push([start, start + line.length]);
    start += line.length + 1;
  }
  return (value, key, offset) => {
    const onHeaderLine = headerLines.some(([from, to]) => offset >= from && offset < to);
    if (
      /[\r\n]/.test(value) ||
      value.includes(delimiter) ||
      (onHeaderLine && /["\\]/.test(value))
    ) {
      throw new UnencodableInputError(key, CANNOT_CARRY);
    }
    return value;
  };
}

/** By media type; null for one with no encoder here. */
function bodyEncoder(
  template: string,
  contentType: string | undefined,
  inputs: Readonly<Record<string, unknown>>,
): PlaceholderEncoder | null {
  const mime = normalizeMime(contentType);
  if (mime === "text/plain") return asIs;
  if (mime === "application/x-www-form-urlencoded") return formComponent;
  if (mime.startsWith("multipart/")) return multipartEncoder(template, contentType!);
  if (JSON_MEDIA_TYPES.has(mime) || mime.endsWith("+json")) return jsonEncoder(template, inputs);
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) {
    return xmlEncoder(template);
  }
  return null;
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
 * type is its rendered `Content-Type` header's, else `contentType`. Throws
 * {@link UnencodableInputError} for a value, {@link RequestTemplateError} for the request as written.
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
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(request.headers)) {
    if (names.has(name.toLowerCase())) {
      throw new RequestTemplateError("headers", `Header "${name}" is written twice`);
    }
    names.add(name.toLowerCase());
    headers[name] = render(value, headerEncoder(name));
  }
  let body: string | null | undefined = request.body;
  if (typeof body === "string" && referencesField(body, text)) {
    const written = headerNamed(request.headers, "content-type") ?? request.contentType;
    const contentType = headerNamed(headers, "content-type") ?? request.contentType;
    const encode = bodyEncoder(body, contentType, inputs);
    if (!encode) {
      // A Content-Type rendered from a value is not echoed.
      const named =
        contentType === undefined
          ? "none"
          : contentType === written
            ? `"${contentType}"`
            : "the one its header renders";
      throw new RequestTemplateError(
        "body",
        `A body with placeholders needs a Content-Type that tells how to encode them (JSON, form, XML, multipart with a boundary, text/plain), not ${named}`,
      );
    }
    body = render(body, encode);
  }
  const url = render(request.url, urlComponent);
  checkPathSegments(request.url, render);
  return { url, headers, body: body as B extends string ? string : B };
}

/** The value of header `name` (lower case), whatever its case. */
export function headerNamed(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}
