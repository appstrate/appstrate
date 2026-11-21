// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an SVG body (an Iconify icon's) paints only near-black: a monochrome black logo such as
 * `logos:github-icon`, which vanishes on a dark surface. Read off the colours it declares in
 * `fill`, `stroke` and `stop-color`, attributes or inline style:
 *
 * - none declared: SVG paints a shape black by default, so it is black;
 * - `currentColor`: it follows the text colour, readable on every theme;
 * - any colour that is not near-black (a brand colour, a white ground) or that cannot be read:
 *   inverting it would change the logo, so it is left as drawn.
 *
 * `none` and `url(#…)` paint nothing of their own (a gradient's colours are its `stop-color`s).
 */
export function isDarkMonochromeSvg(body: string): boolean {
  const colours = [
    ...body.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*([^"';\s>]+)/gi),
  ].map((match) => match[1]!.toLowerCase());
  const painted = colours.filter((colour) => colour !== "none" && !colour.startsWith("url("));
  if (painted.includes("currentcolor")) return false;
  return painted.every((colour) => {
    const luminance = relativeLuminance(colour);
    return luminance !== null && luminance < DARK_LUMINANCE;
  });
}

/** Below this relative luminance a colour reads as black on a dark surface (`#333` is ~0.03). */
const DARK_LUMINANCE = 0.05;

/** WCAG relative luminance of a hex colour or `black`/`white`; `null` for any other notation. */
function relativeLuminance(colour: string): number | null {
  if (colour === "black") return 0;
  if (colour === "white") return 1;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(colour)?.[1];
  if (!hex) return null;
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
