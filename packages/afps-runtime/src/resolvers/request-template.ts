// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * `{{name}}` substitution into an HTTP request, each value encoded for its place so it cannot change
 * the request's structure (AFPS §7.7). Shared by every `api_call` path, the declarative
 * `connect.login` engine and the sidecar's `connect.tool` login. A body is substituted only under a
 * media type it has an encoder for.
 */

import { isHttpFieldValue } from "@appstrate/afps-shared/delivery-http";
import { jsonTextMap } from "@appstrate/afps-shared/json-text";
import {
  headerNamed,
  placeholderBodyEncoding,
  urlTemplateAuthority,
  type BodyEncoding,
} from "@appstrate/afps-shared/request-template";
import {
  referencesField,
  substituteVars,
  unresolvedPlaceholders,
  type PlaceholderEncoder,
} from "./template-vars.ts";

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

/** A body no value can be substituted into as written. Names a media type, never a value. */
export class RequestTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTemplateError";
  }
}

const asIs: PlaceholderEncoder = (value) => value;

type Render = (template: string, encode: PlaceholderEncoder) => string;

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * URL: a placeholder that starts it is a base URL, as is (the caller gates it); any other is one
 * component. A path segment rendered empty, `.` or `..` is refused: percent-encoding neutralises
 * neither.
 */
function renderUrl(template: string, render: Render): string {
  const authority = urlTemplateAuthority(template);
  const rest = template.slice(authority.length);
  const pathEnd = /[?#]|$/.exec(rest)!.index;
  const segments = rest.slice(0, pathEnd).split("/");
  const path = segments.map((segment) => {
    let first: string | undefined;
    const rendered = render(segment, (value, key) => {
      first ??= key;
      return encodeURIComponent(value);
    });
    if (first === undefined) return rendered;
    if (rendered === "") {
      throw new UnencodableInputError(first, "is empty where the URL path needs a segment");
    }
    if (DOT_SEGMENT.test(rendered)) {
      throw new UnencodableInputError(first, "renders a dot segment in the URL path");
    }
    return rendered;
  });
  return (
    render(authority, (value, _key, offset) => (offset === 0 ? value : encodeURIComponent(value))) +
    path.join("/") +
    render(rest.slice(pathEnd), encodeURIComponent)
  );
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

/**
 * multipart: nothing that ends a part (CR, LF, the delimiter). On a part-header line a placeholder
 * sits inside a quoted string, which its value cannot close; anywhere else there it would add a
 * parameter.
 */
function multipartEncoder(template: string, boundary: string): PlaceholderEncoder {
  const delimiter = `--${boundary}`;
  const NOT_HEADER = 0;
  const BARE = 1;
  const QUOTED = 2;
  const place: number[] = [];
  let inHeaders = false;
  let start = 0;
  for (const line of template.split("\n")) {
    if (line.startsWith(delimiter)) inHeaders = true;
    else if (line === "" || line === "\r") inHeaders = false;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      place[start + i] = !inHeaders ? NOT_HEADER : quoted ? QUOTED : BARE;
      if (escaped) escaped = false;
      else if (quoted && line[i] === "\\") escaped = true;
      else if (line[i] === '"') quoted = !quoted;
    }
    start += line.length + 1;
  }
  return (value, key, offset) => {
    if (place[offset] === BARE) {
      throw new RequestTemplateError(
        `{{${key}}} sits in a multipart part header outside a quoted string`,
      );
    }
    if (
      /[\r\n]/.test(value) ||
      value.includes(delimiter) ||
      (place[offset] === QUOTED && /["\\]/.test(value))
    ) {
      throw new UnencodableInputError(key, CANNOT_CARRY);
    }
    return value;
  };
}

function bodyEncoder(
  template: string,
  encoding: BodyEncoding,
  inputs: Readonly<Record<string, unknown>>,
): PlaceholderEncoder {
  switch (encoding.kind) {
    case "text":
      return asIs;
    case "form":
      return formComponent;
    case "multipart":
      return multipartEncoder(template, encoding.boundary);
    case "json":
      return jsonEncoder(template, inputs);
    case "xml":
      return xmlEncoder(template);
  }
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
 * type is its `Content-Type` header's, else `contentType`. Throws {@link UnencodableInputError}
 * for a value (a `null` one a template names included), {@link RequestTemplateError} for a body as
 * written.
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
  const text = jsonTextMap(inputs);
  for (const template of [request.url, ...Object.values(request.headers), request.body ?? ""]) {
    const absent = unresolvedPlaceholders(template, text).find((name) =>
      Object.hasOwn(inputs, name),
    );
    if (absent !== undefined) throw new UnencodableInputError(absent, "is null");
  }
  const render: Render = (template, encode) => substituteWellFormed(template, text, encode);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = render(value, headerEncoder(name));
  }
  let body: string | null | undefined = request.body;
  if (typeof body === "string" && referencesField(body, text)) {
    const encoded = placeholderBodyEncoding(
      headerNamed(request.headers, "content-type") ?? request.contentType,
    );
    if ("issue" in encoded) throw new RequestTemplateError(encoded.issue);
    body = render(body, bodyEncoder(body, encoded.encoding, inputs));
  }
  return {
    url: renderUrl(request.url, render),
    headers,
    body: body as B extends string ? string : B,
  };
}

/** `template` with each `{{name}}` of `fields` rendered by `encode`; a lone surrogate is refused. */
export function substituteWellFormed(
  template: string,
  fields: Readonly<Record<string, string>>,
  encode: PlaceholderEncoder = asIs,
): string {
  return substituteVars(template, fields, {
    keepUnresolved: true,
    encode: (value, key, offset) => {
      if (!value.isWellFormed()) throw new UnencodableInputError(key, CANNOT_CARRY);
      return encode(value, key, offset);
    },
  });
}
