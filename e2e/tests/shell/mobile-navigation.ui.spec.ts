// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

/**
 * On a phone the navigation is a sheet over the page: following one of its
 * links must fold it, or the page the user asked for stays hidden under it.
 */
test("the mobile navigation folds once one of its links is followed", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page
    .getByRole("button", { name: /Afficher ou masquer le menu latéral|Toggle sidebar/ })
    .click();
  const sheet = page.getByRole("dialog", { name: /Menu latéral|Sidebar/ });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/runs/);
  await expect(sheet).toHaveCount(0);
});
