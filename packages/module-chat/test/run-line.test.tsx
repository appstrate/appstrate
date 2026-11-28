// SPDX-License-Identifier: Apache-2.0

/**
 * A run's two-line block, as the context panel's Runs tab draws it: rendered with no chat host
 * around it, everything from its props.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunLine } from "../src/ui/run-line.tsx";

function line(props: Partial<React.ComponentProps<typeof RunLine>> = {}) {
  return renderToStaticMarkup(
    <RunLine
      tile={<span data-tile="" />}
      name="Rapport hebdo"
      sub={<span>Lecture des courriels</span>}
      {...props}
    />,
  );
}

describe("RunLine", () => {
  it("draws the tile in a 32px slot, then the name over what the run says", () => {
    const html = line();
    expect(html).toContain(
      'class="flex size-8 items-center justify-center overflow-hidden rounded-lg"><span data-tile="">',
    );
    expect(html).toContain("truncate text-sm font-medium");
    expect(html.indexOf("Lecture des courriels")).toBeGreaterThan(html.indexOf("Rapport hebdo"));
  });

  it("sets the badge on a 16px disc at the tile's corner, and draws none without one", () => {
    const html = line({ badge: <svg data-badge="" /> });
    expect(html).toContain("absolute -right-1 -bottom-1 flex size-4");
    expect(html).toContain("rounded-full [&amp;_svg]:size-3");
    expect(html).toContain("bg-card absolute -right-1 -bottom-1");
    expect(html).toContain("data-badge");
    expect(line()).not.toContain("-bottom-1");
  });

  it("holds what follows the name on the right, and nothing when there is none", () => {
    const html = line({ trailing: <span>1,2 s</span> });
    expect(html).toContain('ml-auto flex shrink-0 items-center gap-2"><span>1,2 s</span>');
    expect(html.indexOf("1,2 s")).toBeGreaterThan(html.indexOf("Rapport hebdo"));
    expect(line()).not.toContain("ml-auto");
  });

  it("keeps both lines at a fixed height, the second muted, one cell, truncated", () => {
    const html = line();
    expect(html).toContain("flex h-5 min-w-0 items-center gap-2");
    expect(html).toContain(
      "text-muted-foreground grid h-4 min-w-0 text-xs leading-4 *:col-start-1 *:row-start-1 *:truncate",
    );
  });
});
