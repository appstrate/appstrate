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

  const toggle = page.getByRole("button", {
    name: /Afficher ou masquer le menu latéral|Toggle sidebar/,
  });
  await toggle.click();
  const sheet = page.getByRole("dialog", { name: /Menu latéral|Sidebar/ });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/runs/);
  await expect(sheet).toHaveCount(0);

  await toggle.click();
  await sheet.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/runs/);
  await expect(sheet).toHaveCount(0);
});

/**
 * The Studio/Chat switch only swaps the sheet's content: the user picks a section or a
 * conversation next, without reopening it. The page behind still moves to the product's landing.
 */
test("the mobile navigation stays open on a switch between Studio and Chat", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/runs");

  await page
    .getByRole("button", { name: /Afficher ou masquer le menu latéral|Toggle sidebar/ })
    .click();
  const sheet = page.getByRole("dialog", { name: /Menu latéral|Sidebar/ });
  const products = sheet.getByRole("navigation", { name: /Changer de produit|Switch product/ });

  await products.getByRole("link", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(sheet).toBeVisible();

  await products.getByRole("link", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(sheet).toBeVisible();

  // Any other link still folds it.
  await sheet.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/runs/);
  await expect(sheet).toHaveCount(0);
});
