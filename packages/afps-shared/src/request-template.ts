// SPDX-License-Identifier: Apache-2.0

/** `{{name}}` request templates: what the substitution (afps-runtime) and the write-time check share. */

import { normalizeMime } from "./mime.ts";

/** A `{{ name }}` placeholder; group 1 is the name. Global: use with `replace` or `matchAll`. */
export const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export function placeholderKeys(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** The value of header `name` (lower case), whatever its case. */
export function headerNamed(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

/** What precedes the path, query or fragment of a URL template: scheme and authority, or a base-URL placeholder. */
export function urlTemplateAuthority(template: string): string {
  return /^(?:[a-z][a-z\d+.-]*:\/\/)?[^/?#]*/i.exec(template)![0];
}

export type BodyEncoding =
  { kind: "json" | "form" | "xml" | "text" } | { kind: "multipart"; boundary: string };

const JSON_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "text/json",
  "application/x-json",
  "application/x-ndjson",
]);

function bodyEncoding(contentType: string): BodyEncoding | null {
  const mime = normalizeMime(contentType);
  if (mime === "text/plain") return { kind: "text" };
  if (mime === "application/x-www-form-urlencoded") return { kind: "form" };
  if (mime.startsWith("multipart/")) {
    const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i
      .exec(contentType)
      ?.slice(1)
      .find(Boolean);
    return boundary === undefined ? null : { kind: "multipart", boundary };
  }
  if (JSON_MEDIA_TYPES.has(mime) || mime.endsWith("+json")) return { kind: "json" };
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) {
    return { kind: "xml" };
  }
  return null;
}

/** How a text body's `{{name}}` values are encoded under `contentType`, or why not. A placeholder there would let a value pick the encoder. */
export function placeholderBodyEncoding(
  contentType: string | undefined,
): { encoding: BodyEncoding } | { issue: string } {
  const needs = "a body holding a {{name}} needs a Content-Type";
  if (contentType === undefined) {
    return { issue: `${needs} (JSON, form, XML, multipart with a boundary, text/plain)` };
  }
  if (placeholderKeys(contentType).length > 0) {
    return { issue: `${needs} written without a {{name}}` };
  }
  const encoding = bodyEncoding(contentType);
  return encoding
    ? { encoding }
    : {
        issue: `${needs} that tells how to encode it (JSON, form, XML, multipart with a boundary, text/plain), not '${contentType}'`,
      };
}
