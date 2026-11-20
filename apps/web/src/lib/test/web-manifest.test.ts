// SPDX-License-Identifier: Apache-2.0

/**
 * Installing the app on a phone: Chromium needs a name, 192 and 512 px icons, a start URL and a
 * display mode; an explicit `id` and `scope` keep the installed app's identity stable if the start
 * URL ever changes.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "public", "site.webmanifest"), "utf8"),
) as {
  name: string;
  id: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { sizes: string }[];
};

describe("site.webmanifest", () => {
  it("is installable", () => {
    expect(manifest.name).toBe("Appstrate");
    expect(manifest.start_url).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
});
