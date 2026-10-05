// SPDX-License-Identifier: Apache-2.0

/**
 * The two space selectors (sidebar, space-settings breadcrumb) render ONE list,
 * so they cannot disagree on which space may be picked. Source-scanned: a Radix
 * menu renders nothing through `renderToStaticMarkup`. The rule the list
 * applies is `isSpaceEnterable` (`hooks/test/space-resolver.test.ts`).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

describe("space selectors", () => {
  it("both render the shared list", () => {
    for (const file of ["org-switcher.tsx", "space-settings-switcher.tsx"]) {
      expect({ file, shared: source(file).includes("<SpaceMenuItems />") }).toEqual({
        file,
        shared: true,
      });
    }
  });
});
