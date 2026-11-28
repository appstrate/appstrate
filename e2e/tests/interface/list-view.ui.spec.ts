// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration } from "../../helpers/seed.ts";

for (const screen of [
  { path: "/integrations", key: "integrations" },
  { path: "/files", key: "documents" },
]) {
  test(`${screen.key} defaults to cards and respects existing choices`, async ({
    authedPage: page,
  }) => {
    await page.goto(screen.path);
    const cards = page.getByRole("button", { name: "Vue cartes", exact: true });
    const table = page.getByRole("button", { name: "Vue tableau", exact: true });
    await expect(cards).toHaveAttribute("aria-pressed", "true");
    for (const stored of ['"table"', '"cards"', '"invalid"', "{broken"]) {
      await page.evaluate(
        ({ key, stored }) => localStorage.setItem(`appstrate:web:view:${key}`, stored),
        { key: screen.key, stored },
      );
      await page.reload();
      await expect(stored === '"table"' ? table : cards).toHaveAttribute("aria-pressed", "true");
    }
    const other = await page.context().newPage();
    try {
      await other.goto(screen.path);
      await expect(other.getByRole("button", { name: "Vue cartes", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await other.getByRole("button", { name: "Vue tableau", exact: true }).click();
      await expect(table).toHaveAttribute("aria-pressed", "true");
      await cards.click();
      await expect(other.getByRole("button", { name: "Vue cartes", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      await other.close();
    }
    await cards.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(table).toBeFocused();
    await expect(table).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Space");
    await expect(table).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(table).toHaveAttribute("aria-pressed", "true");
    // A choice on either new grid must not change another index's default.
    await page.goto("/agents");
    await expect(page.getByRole("button", { name: "Vue tableau", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

test("integration cards remain reachable on a narrow dark screen", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  const name = `grid-mobile-${Date.now()}`;
  const scope = `@${browserCtx.org.orgSlug}`;
  await createIntegration(apiClient, scope, name);
  await page.goto("/integrations");
  const link = page.getByRole("link", { name: `Test Integration ${name}`, exact: true });
  await expect(link).toBeVisible();
  // The unfiltered list also shows system integrations: read the count on this card only
  // (the deepest element holding both the title link and the count).
  const card = page
    .locator("div")
    .filter({ has: link })
    .filter({ hasText: /0 connexion/ })
    .last();
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("integrations-grid-mobile.png"),
    fullPage: true,
  });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/integrations/${scope}/${name}$`));
  await expect(page.getByRole("tab", { name: /Vue d[’']ensemble/ })).toBeVisible();
});
