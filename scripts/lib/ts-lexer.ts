// SPDX-License-Identifier: Apache-2.0

/** Walking TypeScript past what is not code, shared by the two module gates so they agree. */

/** Characters after which `/` opens a regex, not a division. `<`/`>` are excluded on purpose:
 * these scans read `.tsx`, where `</div>` would open a phantom regex over the rest of the file. */
export const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^");

/** Index just past the literal opened at `start`; a regex ends at a newline, a quote at EOF. */
export function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") i += 2;
    else if (source[i] === quote) return i + 1;
    else if (quote === "/" && source[i] === "\n") return i;
    else i += 1;
  }
  return source.length;
}

/** Index just past the `${…}` at `start`; inner literals are skipped whole (`${cond ? "}" : x}`). */
export function skipInterpolation(source: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      if (ch === "`") {
        i += 1;
        while (i < source.length && source[i] !== "`") {
          if (source[i] === "\\") i += 2;
          else if (source[i] === "$" && source[i + 1] === "{") i = skipInterpolation(source, i);
          else i += 1;
        }
        i += 1;
      } else {
        i = scanQuoted(source, i, ch);
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return i;
}
