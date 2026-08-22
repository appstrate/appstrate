// SPDX-License-Identifier: Apache-2.0

/**
 * A dial for one open question: how deep the grey canvas should be.
 *
 * `--canvas` is 1.5% off white today, and that single number decides whether
 * three separate controls read: the two toolbar button treatments (one is a
 * fill, the other is the absence of one), the view toggle's track, and every
 * white card against the page. Judging it from screenshots does not work —
 * the eye needs the same screen at two values, seconds apart, at a real size.
 *
 * So it lives in the lab panel rather than in a paste-into-the-console
 * snippet, and it survives a reload so a value can be carried across scenarios
 * and widths. **It is an instrument, not a setting**: once the product owner
 * picks one, the winner becomes the token in `styles.css` and this file goes.
 */

const KEY = "appstrate-lab-canvas";
const STYLE_ID = "lab-canvas-depth";

/**
 * Lightness in oklch, with what each one actually RENDERS to in sRGB — read
 * off a canvas pixel, not converted by hand, because the eyeballed values were
 * wrong by several points the first time. `A` is what ships today.
 */
export const DEPTHS = {
  A: { lightness: "0.985", note: "#FAFAFA · actuel · 2 % du blanc" },
  B: { lightness: "0.972", note: "#F6F6F6 · 3,5 %" },
  C: { lightness: "0.958", note: "#F1F1F1 · 5,5 %" },
} as const;

export type Depth = keyof typeof DEPTHS;

export function getDepth(): Depth {
  const stored = localStorage.getItem(KEY);
  return stored === "B" || stored === "C" ? stored : "A";
}

/**
 * No reload, unlike the scenario switch: the point is to see the SAME pixels
 * change under the same eye, and a reload loses the scroll and the comparison.
 */
export function applyDepth(depth: Depth): void {
  localStorage.setItem(KEY, depth);
  const style =
    document.getElementById(STYLE_ID) ??
    document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID }));
  // The sidebar reads the same token in the target design, so it moves too —
  // a canvas deepened under the content alone is a different design, not a
  // deeper one.
  style.textContent =
    depth === "A"
      ? ""
      : `:root{--canvas:oklch(${DEPTHS[depth].lightness} 0 0);--sidebar:oklch(${DEPTHS[depth].lightness} 0 0)}`;
}
