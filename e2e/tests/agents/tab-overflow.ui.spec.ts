// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for the collapsing tab bar (`TabsList` in `@appstrate/ui`).
 *
 * This is the ONLY rendering-level coverage the component can have: the repo
 * has no DOM test environment (`mock.module()` and global `window`/`document`
 * stubs are banned because every unit test shares one process), so the unit
 * tests can only reach the pure arithmetic in `packages/ui/src/lib/tab-overflow`.
 * Everything that made the bar wrap in the first place — measurement, the
 * ResizeObserver, the partition actually reaching the DOM — only exists in a
 * browser.
 *
 * The agent detail page is the worst case by construction: it carries nine
 * triggers for a freshly created agent and ten once it has unpublished changes.
 *
 * Each test drives the viewport itself rather than relying on the suite's
 * default. How many tabs an agent shows depends on its state (`Modifications`
 * only appears with unpublished changes), so "does it overflow at width W" is
 * only a stable assertion when W is chosen per case.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent } from "../../helpers/seed.ts";

/** `h-9` on the pill: one row is 36px. A wrapped bar is ~68px and climbing. */
const ONE_ROW_MAX_HEIGHT = 44;

const OVERFLOW_BUTTON = { name: "Plus d'onglets" };

async function gotoNewAgent(
  page: import("@playwright/test").Page,
  apiClient: Parameters<typeof createAgent>[0],
  orgSlug: string,
  label: string,
): Promise<void> {
  const scope = `@${orgSlug}`;
  const name = `${label}-${Date.now()}`;
  await createAgent(apiClient, scope, name);
  await page.goto(`/agents/${scope}/${name}`);
  await expect(page.getByRole("tablist")).toBeVisible();
}

test.describe("Tab bar overflow", () => {
  test("collapses into the overflow menu when the bar does not fit", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    // Narrow enough that nine triggers cannot fit next to the sidebar. This is
    // the case that used to wrap onto a second row.
    await page.setViewportSize({ width: 900, height: 720 });
    await gotoNewAgent(page, apiClient, browserCtx.org.orgSlug, "tab-overflow");

    const tablist = page.getByRole("tablist");
    const overflow = page.getByRole("button", OVERFLOW_BUTTON);
    await expect(overflow).toBeVisible();

    const box = await tablist.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);

    // The active tab is never collapsed — an agent lands on Runs.
    await expect(tablist.getByRole("tab", { name: "Runs" })).toHaveAttribute(
      "data-state",
      "active",
    );

    // A collapsed tab is reachable and actually switches the panel. "Package
    // AFPS" is near the end of the source order, so it is in the overflow here.
    await overflow.click();
    const hiddenItem = page.getByRole("menuitemradio", { name: "Package AFPS" });
    await expect(hiddenItem).toBeVisible();
    await hiddenItem.click();

    // Selecting from the menu promotes the tab into the visible row, because
    // the partition never hides the active one.
    await expect(tablist.getByRole("tab", { name: "Package AFPS" })).toHaveAttribute(
      "data-state",
      "active",
    );

    // Still one row after the switch: promoting the active tab has to evict
    // another one, not widen the bar.
    const afterBox = await tablist.boundingBox();
    expect(afterBox!.height).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);
  });

  test("stays on one row without collapsing when everything fits", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    await gotoNewAgent(page, apiClient, browserCtx.org.orgSlug, "tab-fits");

    // A bar that fits must NOT reserve the "…" — reserving it unconditionally
    // would collapse a bar that fits exactly.
    await expect(page.getByRole("button", OVERFLOW_BUTTON)).toHaveCount(0);

    const box = await page.getByRole("tablist").boundingBox();
    expect(box!.height).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);
  });

  test("collapses and expands as the viewport is resized", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    await gotoNewAgent(page, apiClient, browserCtx.org.orgSlug, "tab-resize");

    const overflow = page.getByRole("button", OVERFLOW_BUTTON);
    await expect(overflow).toHaveCount(0);

    // Shrinking must collapse rather than wrap...
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(overflow).toBeVisible();
    expect((await page.getByRole("tablist").boundingBox())!.height).toBeLessThanOrEqual(
      ONE_ROW_MAX_HEIGHT,
    );

    // ...and growing must give the tabs back. This is the direction that breaks
    // when the measured width is the bar's own content width: once collapsed,
    // such a bar can never observe that it has room again.
    await page.setViewportSize({ width: 1600, height: 720 });
    await expect(overflow).toHaveCount(0);
  });
});
