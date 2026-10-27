// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { AUTO_COLOR, colorChange } from "../appearance-change.ts";

describe("colorChange", () => {
  it("sends a swatch's key as the colour", () => {
    expect(colorChange("rose")).toEqual({ color: "rose" });
    expect(colorChange("neutral")).toEqual({ color: "neutral" });
  });

  it("sends a null colour for the automatic choice", () => {
    expect(colorChange(AUTO_COLOR)).toEqual({ color: null });
  });

  it("never sends a colour outside the palette", () => {
    expect(colorChange("hotpink")).toEqual({ color: null });
  });
});
