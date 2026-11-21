// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isDarkMonochromeSvg } from "../dark-glyph.ts";

describe("isDarkMonochromeSvg", () => {
  it("reads a logo painted in near-black only as dark (logos:github-icon, logos:linear-icon)", () => {
    expect(isDarkMonochromeSvg('<path fill="#161614" d="M0 0"/>')).toBe(true);
    expect(isDarkMonochromeSvg('<path fill="#222326" d="M0 0"/><path fill="#000" d="M1 1"/>')).toBe(
      true,
    );
  });

  it("reads a body declaring no colour as dark: SVG paints a shape black by default", () => {
    expect(isDarkMonochromeSvg('<path d="M0 0"/>')).toBe(true);
  });

  it("reads colours given in inline style and in a gradient's stops", () => {
    expect(isDarkMonochromeSvg('<path style="fill:#111" d="M0 0"/>')).toBe(true);
    expect(
      isDarkMonochromeSvg(
        '<defs><linearGradient id="g"><stop stop-color="#000"/><stop stop-color="#3c90ff"/></linearGradient></defs><path fill="url(#g)" d="M0 0"/>',
      ),
    ).toBe(false);
  });

  it("leaves a logo with a brand colour or a light ground as drawn (logos:asana, logos:notion-icon)", () => {
    expect(isDarkMonochromeSvg('<path fill="#f06a6a"/><path fill="#0d0e10"/>')).toBe(false);
    expect(isDarkMonochromeSvg('<path fill="#fff"/><path d="M0 0"/>')).toBe(false);
  });

  it("leaves a glyph that follows the text colour alone (simple-icons)", () => {
    expect(isDarkMonochromeSvg('<path fill="currentColor" d="M0 0"/>')).toBe(false);
  });

  it("leaves a colour it cannot read as drawn", () => {
    expect(isDarkMonochromeSvg('<path fill="rgb(0,0,0)" d="M0 0"/>')).toBe(false);
  });

  it("ignores what paints nothing of its own", () => {
    expect(isDarkMonochromeSvg('<path fill="none" stroke="#1a1a1a" d="M0 0"/>')).toBe(true);
  });
});
