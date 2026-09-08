// SPDX-License-Identifier: Apache-2.0

/**
 * The lexical half of the two module gates: how to walk TypeScript source past
 * the things that are not code — comments, string and template literals, regex
 * literals — without a `//` inside a specifier opening a comment or an
 * unterminated quote swallowing the rest of the file.
 *
 * `verify-module-isolation.ts` walks it to blank comments before reading import
 * specifiers; `verify-module-sql-boundary.ts` walks it to blank everything that
 * is not executed SQL. The two keep their own walks — one preserves text, the
 * other blanks it and counts the literals it kept — but the primitives those
 * walks are built from live here, once. Two copies of "where does this literal
 * end" is two chances for the gates to disagree about what a file contains, and
 * a gate that mis-tokenizes reports the exact opposite of the truth: it blanks
 * live code, or reads prose as code.
 */

/**
 * Characters after which a `/` opens a regex literal rather than a division.
 *
 * `<` and `>` are left out on purpose: these scans read `.tsx`, where `</div>`
 * would otherwise open a phantom regex that blanks the rest of the file and
 * hides — or falsely reports — whatever follows. The cost is a regex literal
 * written directly after a comparison operator, which no scanned file does.
 */
export const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^");

/**
 * Index just past the literal opened at `start` with `quote` (`"`, `'`, `` ` ``
 * or `/` for a regex).
 *
 * Handles the backslash escape, which is what keeps `"a\"b"` from ending at the
 * middle quote and inverting every decision after it. A regex stops at a
 * newline — one cannot span lines, so an unterminated `/` gives up its line
 * rather than the file. An unterminated quote returns the end of the source.
 */
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

/**
 * Index just past the `${…}` interpolation opened at `start`.
 *
 * Braces are counted, and string / template literals inside are skipped whole:
 * `${cond ? "}" : x}` closes on the wrong brace otherwise, and a nested
 * template (`${a}${`b${c}`}`) needs the recursion this loop performs by
 * re-entering on its own backtick branch.
 */
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
