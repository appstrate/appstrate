// SPDX-License-Identifier: Apache-2.0

/**
 * The two space selectors (sidebar, space-settings breadcrumb) offer the same
 * choices under the same rule. Source-scanned: a Radix menu renders nothing
 * through `renderToStaticMarkup`, and the rule is "there is one list".
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

describe("space selectors", () => {
  const selectors = ["org-switcher.tsx", "space-settings-switcher.tsx"];

  it("render the shared list and never switch space on their own", () => {
    for (const file of selectors) {
      const text = source(file);
      expect({ file, shared: text.includes("<SpaceMenuItems />") }).toEqual({ file, shared: true });
      expect({ file, switches: /switchSpace|useSpaceSwitcher/.test(text) }).toEqual({
        file,
        switches: false,
      });
    }
  });

  it("only lets an enterable space be picked", () => {
    const list = source("space-menu-items.tsx");
    expect(list).toContain('const enterable = space.access === "member";');
    expect(list).toContain("disabled={!enterable}");
    expect(list).toContain("if (enterable && !isActive) switchSpace(space.id);");
  });
});
