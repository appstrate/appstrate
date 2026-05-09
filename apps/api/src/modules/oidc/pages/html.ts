// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny HTML rendering helpers — XSS-safe string interpolation.
 *
 * Hand-rolled instead of pulling in a templating library so the OIDC
 * module stays dependency-free. Every dynamic value that ends up inside
 * HTML MUST go through `escapeHtml()` or the tagged `html` helper.
 */

import { escapeHtml } from "@appstrate/core/html";

export { escapeHtml };

/**
 * Tagged template that auto-escapes every interpolated value. Use it for
 * the final assembly of a page so no raw string can reach the HTML body
 * without going through `escapeHtml`. Nested `RawHtml` instances (from a
 * trusted sub-render) are passed through verbatim.
 */
export class RawHtml {
  constructor(public readonly value: string) {}
}

export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

export function html(
  strings: TemplateStringsArray,
  ...values: Array<string | number | RawHtml | RawHtml[] | undefined | null>
): RawHtml {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v === undefined || v === null) continue;
      if (v instanceof RawHtml) {
        out += v.value;
      } else if (Array.isArray(v)) {
        out += v.map((item) => item.value).join("");
      } else {
        out += escapeHtml(String(v));
      }
    }
  }
  return new RawHtml(out);
}
