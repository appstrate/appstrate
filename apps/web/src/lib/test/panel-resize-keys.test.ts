// SPDX-License-Identifier: Apache-2.0

/**
 * A resize handle's keys: the arrow pointing past its edge widens the panel, so the right edge
 * (the chat's sidebar) answers the arrows the other way round from the left one (the context panel).
 */

import { describe, expect, it } from "bun:test";
import { keyedWidth } from "../panel-resize-keys.ts";

const bounds = { width: 300, min: 224, max: 480 };

describe("keyedWidth", () => {
  it("widens toward the left edge with ArrowLeft", () => {
    expect(keyedWidth("ArrowLeft", { edge: "left", ...bounds })).toBe(324);
    expect(keyedWidth("ArrowRight", { edge: "left", ...bounds })).toBe(276);
  });

  it("widens toward the right edge with ArrowRight", () => {
    expect(keyedWidth("ArrowRight", { edge: "right", ...bounds })).toBe(324);
    expect(keyedWidth("ArrowLeft", { edge: "right", ...bounds })).toBe(276);
  });

  it("jumps to the bounds with Home and End, whatever the edge", () => {
    for (const edge of ["left", "right"] as const) {
      expect(keyedWidth("Home", { edge, ...bounds })).toBe(224);
      expect(keyedWidth("End", { edge, ...bounds })).toBe(480);
    }
    expect(keyedWidth("End", { edge: "left", ...bounds, max: Infinity })).toBeNull();
  });

  it("ignores other keys", () => {
    expect(keyedWidth("Enter", { edge: "right", ...bounds })).toBeNull();
  });
});
