// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ORG_LOGO_MAX_LENGTH, ORG_LOGO_WEBP_PREFIX } from "@appstrate/core/validation";
import { storableLogo } from "../org-logo.ts";

describe("storableLogo", () => {
  it("keeps a WebP encoding within the limit", () => {
    const logo = `${ORG_LOGO_WEBP_PREFIX}AAAA`;
    expect(storableLogo(logo)).toBe(logo);
  });

  it("asks for a smaller size when the encoding is too long", () => {
    expect(storableLogo(ORG_LOGO_WEBP_PREFIX.padEnd(ORG_LOGO_MAX_LENGTH + 1, "A"))).toBeNull();
  });

  it("refuses the PNG a browser without a WebP encoder hands back", () => {
    expect(() => storableLogo("data:image/png;base64,AAAA")).toThrow("logo_processing");
  });
});
