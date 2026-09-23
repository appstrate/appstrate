// SPDX-License-Identifier: Apache-2.0

/**
 * The one JSONPath dialect of AFPS integration manifests — the single-value
 * RFC 9535 subset read by `identity_claims` and by the login engine's
 * `jsonpath` selectors and success criteria:
 *
 *   `$`                     the root
 *   `.name`                 a member (any characters but `.` and `[`, not
 *                           starting with a digit — RFC 9535 shorthand)
 *   `['name']` `["name"]`   a quoted member
 *   `[0]` `[-1]`            an array index, negative from the end
 *
 * Filters, slices, wildcards and recursive descent throw
 * {@link JsonPathSyntaxError}: an unsupported query must fail loudly, never
 * evaluate to a silent miss.
 */

export class JsonPathSyntaxError extends Error {
  override readonly name = "JsonPathSyntaxError";
}

type JsonPathSegment = string | number;

/** Tokenize `path` into member names and array indices. Throws on anything outside the subset. */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (!path.startsWith("$")) {
    throw new JsonPathSyntaxError(`jsonpath '${path}' must start with '$'`);
  }
  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === ".") {
      i++;
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
      const key = path.slice(i, end);
      if (key.length === 0) {
        throw new JsonPathSyntaxError(
          `jsonpath '${path}' has an empty segment (recursive descent is not supported)`,
        );
      }
      if (key === "*") {
        throw new JsonPathSyntaxError(`jsonpath '${path}' uses a wildcard, which is not supported`);
      }
      if (/^\d/.test(key)) {
        throw new JsonPathSyntaxError(
          `jsonpath '${path}' has a member '.${key}' starting with a digit — write an index as [${key}] or a member as ['${key}']`,
        );
      }
      segments.push(key);
      i = end;
    } else if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) {
        throw new JsonPathSyntaxError(`unterminated '[' in jsonpath '${path}'`);
      }
      const inner = path.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else if (
        inner.length >= 2 &&
        ((inner.startsWith("'") && inner.endsWith("'")) ||
          (inner.startsWith('"') && inner.endsWith('"')))
      ) {
        segments.push(inner.slice(1, -1));
      } else {
        throw new JsonPathSyntaxError(
          `unsupported jsonpath segment '[${inner}]' in '${path}' (filters, slices and wildcards are not supported)`,
        );
      }
      i = close + 1;
    } else {
      throw new JsonPathSyntaxError(`unexpected character '${ch}' in jsonpath '${path}'`);
    }
  }
  return segments;
}

/**
 * Evaluate `path` against `root`. Returns `undefined` when the path is valid
 * but selects nothing; throws {@link JsonPathSyntaxError} when it is invalid.
 * Members are own properties only, so `$.constructor` cannot reach a prototype.
 */
export function evaluateJsonPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parseJsonPath(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg < 0 ? cur.length + seg : seg];
    } else {
      // Not `Object.hasOwn`: the web app compiles this leaf against ES2020.
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}
