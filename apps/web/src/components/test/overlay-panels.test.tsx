// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { i18nReady } from "../../i18n.ts";
import { OverlayPanelSkeleton } from "../loading-skeletons.tsx";
import { PanelLayout } from "../panel-layout.tsx";
import { render } from "../../test/render.tsx";

await i18nReady;

// A Radix dialog renders into a portal, which `renderToStaticMarkup` drops: a
// panel that opened a dialog of its own would come out empty here. These
// assertions therefore pin the invariant #2008 broke — the panes are plain
// content, so the one dialog (`OverlayFrame`) stays open while they change.
describe("panel overlay panes", () => {
  it("draw the skeleton in place, with no dialog of their own", () => {
    for (const list of [true, false]) {
      const html = render(<OverlayPanelSkeleton list={list} />);
      expect(html).toContain("<aside");
      expect(html).toContain('role="status"');
      expect(html).not.toContain('role="dialog"');
    }
  });

  it("lay the rail and the page out as the skeleton does", () => {
    const html = render(
      <PanelLayout title="Réglages" rail={<nav>la-rail</nav>} contentHeader={() => null}>
        <p>la-page</p>
      </PanelLayout>,
    );
    expect(html).toContain("<aside");
    expect(html).toContain("la-rail");
    expect(html).toContain("la-page");
    expect(html).not.toContain('role="dialog"');
  });
});
