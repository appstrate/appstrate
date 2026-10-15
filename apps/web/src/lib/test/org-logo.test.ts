// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ORG_LOGO_MAX_BYTES } from "@appstrate/core/validation";
import { storableLogo } from "../org-logo.ts";

describe("storableLogo", () => {
  it("keeps a WebP encoding within the limit", () => {
    const logo = new Blob([new Uint8Array(16)], { type: "image/webp" });
    expect(storableLogo(logo)).toBe(logo);
  });

  it("asks for a smaller size when the encoding is too large", () => {
    const logo = new Blob([new Uint8Array(ORG_LOGO_MAX_BYTES + 1)], { type: "image/webp" });
    expect(storableLogo(logo)).toBeNull();
  });

  it("refuses the PNG a browser without a WebP encoder hands back", () => {
    const png = new Blob([new Uint8Array(16)], { type: "image/png" });
    expect(() => storableLogo(png)).toThrow("logo_processing");
  });
});
