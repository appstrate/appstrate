// SPDX-License-Identifier: Apache-2.0

/**
 * A panel overlay (catalogue, settings) opens ONCE on a cold address.
 *
 * The overlay's chunk is not loaded when the address is pasted, so its
 * skeleton shows first and the page replaces it. The skeleton used to be a
 * dialog of its own, unmounted when the page's dialog mounted: the backdrop
 * faded in again and the box re-ran its zoom, as if the overlay closed and
 * reopened (#2008). The frame is now one dialog above both, so the one dialog
 * element must live through the whole load.
 *
 * Counting dialog and backdrop elements ever ADDED (not just present at the
 * end) is what tells the two apart: after the swap both versions show one.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("a cold catalogue address keeps one dialog and one backdrop from skeleton to page", async ({
  authedPage: page,
}) => {
  // Hold the catalogue chunk back so the skeleton is on screen for long enough
  // to see; `held` proves the fallback really was reached.
  let held = false;
  await page.route(/\/assets\/catalogue-[\w-]{8}\.js/, async (route) => {
    held = true;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  await page.addInitScript(() => {
    const seen = { dialogs: new WeakSet<Element>(), backdrops: new WeakSet<Element>() };
    const added = { dialogs: 0, backdrops: 0 };
    Object.assign(window, { __overlayAdded: added });
    const count = (node: Node) => {
      if (!(node instanceof Element)) return;
      for (const el of [node, ...node.querySelectorAll("*")]) {
        if (el.getAttribute("role") === "dialog" && !seen.dialogs.has(el)) {
          seen.dialogs.add(el);
          added.dialogs += 1;
        }
        if (el.className.toString().includes("bg-black/80") && !seen.backdrops.has(el)) {
          seen.backdrops.add(el);
          added.backdrops += 1;
        }
      }
    };
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(count);
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto("/catalogue/discover/agent");

  // The skeleton: the dialog is open and the panes are still blocks.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status").first()).toBeVisible();
  expect(await dialog.locator("aside nav").count()).toBe(0);

  // The page: the rail is drawn, in the same dialog.
  await expect(dialog.locator("aside nav").first()).toBeVisible({ timeout: 15_000 });
  expect(held).toBe(true);

  const added = await page.evaluate(
    () =>
      (window as unknown as { __overlayAdded: { dialogs: number; backdrops: number } })
        .__overlayAdded,
  );
  expect(added).toEqual({ dialogs: 1, backdrops: 1 });
});
