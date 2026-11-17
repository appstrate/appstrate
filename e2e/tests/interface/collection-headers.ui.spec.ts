// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

for (const width of [1440, 390]) {
  test(`collection headers align across pages at ${width}px`, async ({ authedPage: page }) => {
    await page.setViewportSize({ width, height: 900 });
    let reference: { height: number; top: number; gap: number } | undefined;
    for (const path of ["/files", "/integrations", "/agents", "/skills", "/runs", "/schedules"]) {
      await page.goto(path);
      await expect(page.locator("[data-page-header] h1")).toBeVisible();
      await expect(page.getByRole("textbox")).toBeVisible();
      const geometry = await page.locator("[data-page-header]").evaluate((header) => {
        const box = header.getBoundingClientRect();
        const toolbar = header.nextElementSibling;
        if (!toolbar) throw new Error("No collection toolbar");
        return {
          height: box.height,
          top: box.top,
          gap: toolbar.getBoundingClientRect().top - box.bottom,
        };
      });
      reference ??= geometry;
      expect(geometry, path).toEqual(reference);
    }
  });
}
