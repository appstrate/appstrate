// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { keyboardViewport } from "../src/use-keyboard-viewport.ts";

const phone = { height: 812, offsetTop: 0, scale: 1 };

describe("keyboardViewport", () => {
  it("reports the visible area when a keyboard covers the layout viewport", () => {
    expect(keyboardViewport({ ...phone, height: 478 }, 812)).toEqual({ height: 478, top: 0 });
  });

  it("carries how far iOS panned the visual viewport", () => {
    expect(keyboardViewport({ height: 478, offsetTop: 96.4, scale: 1 }, 812)).toEqual({
      height: 478,
      top: 96,
    });
  });

  it("reports nothing when the layout viewport already follows the keyboard", () => {
    expect(keyboardViewport({ ...phone, height: 478 }, 478)).toBeNull();
  });

  it("reports nothing without a keyboard", () => {
    expect(keyboardViewport(phone, 812)).toBeNull();
  });

  it("ignores the browser toolbars sliding in and out", () => {
    expect(keyboardViewport({ ...phone, height: 760 }, 812)).toBeNull();
  });

  it("ignores a pinch-zoomed page, whose visual viewport is smaller on purpose", () => {
    expect(keyboardViewport({ height: 406, offsetTop: 0, scale: 2 }, 812)).toBeNull();
  });

  it.each([-16, 16])("leaves native focus panning in charge when only %i px remain", (height) => {
    expect(keyboardViewport({ height, offsetTop: 60, scale: 1 }, 292)).toBeNull();
  });

  it("never returns a negative offset", () => {
    expect(keyboardViewport({ height: 478, offsetTop: -3, scale: 1 }, 812)?.top).toBe(0);
  });
});
