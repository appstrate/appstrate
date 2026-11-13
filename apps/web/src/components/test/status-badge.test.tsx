// SPDX-License-Identifier: Apache-2.0

/**
 * The compact run status: its container decides between the icon and the badge,
 * not the screen — a narrow table on a wide screen collapses too.
 */

import { describe, it, expect } from "bun:test";
import { RunStatusBadge } from "../status-badge.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("RunStatusBadge compact", () => {
  const html = render(<RunStatusBadge status="success" compact />);

  it("switches on its container's width, not the viewport's", () => {
    expect(html).toContain("@lg:hidden");
    expect(html).toContain("@lg:inline-flex");
    expect(html).not.toContain("sm:");
  });

  it("names the status for a screen reader when only the icon shows", () => {
    expect(html).toMatch(/<span class="sr-only">succès<\/span>/);
  });
});
