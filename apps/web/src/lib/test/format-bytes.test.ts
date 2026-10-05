// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { formatBytes } from "../format-bytes.ts";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

describe("formatBytes", () => {
  it("counts in octets with a decimal comma in French", async () => {
    await i18n.changeLanguage("fr");
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(2048)).toBe("2,0 Ko");
    expect(formatBytes(1024 * 1024)).toBe("1,0 Mo");
    expect(formatBytes(12 * 1024 ** 3)).toBe("12 Go");
  });

  it("keeps the binary-unit spelling in English", async () => {
    await i18n.changeLanguage("en");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
