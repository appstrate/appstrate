// SPDX-License-Identifier: Apache-2.0

const KEY_STEP = 24;

/**
 * The unclamped width a key asks for, or null for a key the handle ignores.
 * The arrow pointing past the edge widens the panel.
 */
export function keyedWidth(
  key: string,
  { edge, width, min, max }: { edge: "left" | "right"; width: number; min: number; max: number },
): number | null {
  const grow = edge === "left" ? "ArrowLeft" : "ArrowRight";
  const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft";
  if (key === grow) return width + KEY_STEP;
  if (key === shrink) return width - KEY_STEP;
  if (key === "Home") return min;
  if (key === "End" && Number.isFinite(max)) return max;
  return null;
}
