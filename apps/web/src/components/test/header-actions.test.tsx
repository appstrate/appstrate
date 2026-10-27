// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { render } from "../../test/render.tsx";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { HeaderActionButton } from "../header-action-button.tsx";
import { PageActionsMenu } from "../page-actions-menu.tsx";
import { RunHeaderActions } from "../run-detail/run-header-summary.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

/** The class attribute of every `<button>` in `html`. */
function buttonClasses(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*\bclass="([^"]*)"/g)].map((m) => m[1]!);
}

const hasClass = (classes: string, name: string) => classes.split(/\s+/).includes(name);

describe("detail page header controls", () => {
  it("draw the outline deeds at the toolbar's height on a surface", () => {
    const html = render(
      <>
        <HeaderActionButton>Run</HeaderActionButton>
        <RunHeaderActions
          canRerun
          canCancel
          rerunPending={false}
          cancelPending={false}
          onRerun={() => {}}
          onCancel={() => {}}
        />
        <PageActionsMenu>
          <span />
        </PageActionsMenu>
      </>,
    );
    const classes = buttonClasses(html);

    // A run bar's two deeds, the shared button, the Actions menu's trigger.
    expect(classes).toHaveLength(4);
    for (const c of classes) {
      expect(hasClass(c, "h-8")).toBe(true);
      expect(hasClass(c, "h-9")).toBe(false);
      expect(hasClass(c, "bg-card")).toBe(true);
      expect(hasClass(c, "px-2.5")).toBe(true);
    }
  });

  it("keeps the filled button at the same height, with the variant's own fill", () => {
    const [primary] = buttonClasses(
      render(<HeaderActionButton primary>Activate</HeaderActionButton>),
    );

    expect(hasClass(primary!, "h-8")).toBe(true);
    expect(hasClass(primary!, "bg-primary")).toBe(true);
    expect(hasClass(primary!, "bg-card")).toBe(false);
  });
});
