// SPDX-License-Identifier: Apache-2.0

/**
 * The JSONPath dialect of AFPS integration manifests — a single-value RFC 9535
 * subset: `$`, `.name` (member-name-shorthand), `['name']` / `["name"]` (RFC
 * 9535 string literals and escapes), `[0]` / `[-1]` (RFC 9535 `int`). Anything
 * else throws {@link JsonPathSyntaxError} rather than silently missing.
 */

export class JsonPathSyntaxError extends Error {
  override readonly name = "JsonPathSyntaxError";
}

type JsonPathSegment = string | number;

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  "/": "/",
  "\\": "\\",
};

const isDigit = (ch: string) => ch >= "0" && ch <= "9";
const isNameFirst = (ch: string) =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch.charCodeAt(0) >= 0x80;
const isBlank = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** Tokenize `path` into member names and array indices. Throws on anything outside the subset. */
export function parseJsonPath(path: string): JsonPathSegment[] {
  const fail = (at: number, what: string): never => {
    throw new JsonPathSyntaxError(`jsonpath '${path}' at offset ${at}: ${what}`);
  };
  if (path[0] !== "$") fail(0, "must start with '$'");

  const segments: JsonPathSegment[] = [];
  let i = 1;
  const skipBlank = () => {
    while (isBlank(path[i])) i++;
  };

  const readString = (quote: string): string => {
    const start = i;
    i++;
    let out = "";
    while (i < path.length) {
      const ch = path[i]!;
      if (ch === quote) {
        i++;
        return out;
      }
      if (ch.charCodeAt(0) < 0x20) fail(i, "unescaped control character in string");
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      const esc = path[i + 1];
      if (esc === quote) out += quote;
      else if (esc !== undefined && esc in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[esc];
      else if (esc === "u") {
        const unit = readHex4(i + 2);
        if (unit >= 0xdc00 && unit <= 0xdfff) fail(i, "lone low surrogate escape");
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = path.startsWith("\\u", i + 6) ? readHex4(i + 8) : -1;
          if (low < 0xdc00 || low > 0xdfff)
            fail(i, "high surrogate escape without a low surrogate");
          out += String.fromCharCode(unit, low);
          i += 12;
          continue;
        }
        out += String.fromCharCode(unit);
        i += 6;
        continue;
      } else fail(i, `invalid escape '\\${esc ?? ""}'`);
      i += 2;
    }
    return fail(start, "unterminated string");
  };

  const readHex4 = (at: number): number => {
    const hex = path.slice(at, at + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail(at, "\\u must be followed by 4 hex digits");
    return parseInt(hex, 16);
  };

  const readInt = (): number => {
    const start = i;
    if (path[i] === "-") i++;
    const digitsAt = i;
    while (isDigit(path[i] ?? "")) i++;
    const text = path.slice(start, i);
    if (i === digitsAt) fail(start, "expected an index");
    if (text === "-0" || (path[digitsAt] === "0" && i - digitsAt > 1)) {
      fail(start, `index '${text}' is not an RFC 9535 int (no leading zeros, no -0)`);
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n)) fail(start, `index '${text}' is out of range`);
    return n;
  };

  while (i < path.length) {
    const ch = path[i]!;
    if (ch === ".") {
      i++;
      const start = i;
      const first = path[i];
      if (first === ".") fail(start, "recursive descent is not supported");
      if (first === "*") fail(start, "a wildcard is not supported");
      if (first !== undefined && isDigit(first)) {
        fail(
          start,
          "a member name cannot start with a digit — write an index as [0] or a member as ['0']",
        );
      }
      if (first === undefined || !isNameFirst(first)) fail(start, "expected a member name");
      while (i < path.length && (isNameFirst(path[i]!) || isDigit(path[i]!))) i++;
      segments.push(path.slice(start, i));
    } else if (ch === "[") {
      i++;
      skipBlank();
      const sel = path[i];
      if (sel === "'" || sel === '"') segments.push(readString(sel));
      else if (sel === "-" || (sel !== undefined && isDigit(sel))) segments.push(readInt());
      else if (sel === undefined) fail(i, "unterminated '['");
      else
        fail(i, `unsupported selector '${sel}' (wildcards, filters and slices are not supported)`);
      skipBlank();
      if (path[i] === ",") fail(i, "a union of selectors is not supported");
      if (path[i] === ":") fail(i, "a slice is not supported");
      if (path[i] !== "]") fail(i, path[i] === undefined ? "unterminated '['" : "expected ']'");
      i++;
    } else {
      fail(i, `unexpected character '${ch}'`);
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
