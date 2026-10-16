// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration } from "../../helpers/seed.ts";

for (const screen of [
  { path: "/integrations?execution=local", key: "integrations" },
  { path: "/files", key: "documents" },
]) {
  test(`${screen.key} defaults to cards and respects existing choices`, async ({
    authedPage: page,
  }) => {
    await page.goto(screen.path);
    const cards = page.getByRole("tab", { name: "Vue cartes", exact: true });
    const table = page.getByRole("tab", { name: "Vue tableau", exact: true });
    await expect(cards).toHaveAttribute("data-state", "active");
    for (const stored of ['"table"', '"cards"', '"invalid"', "{broken"]) {
      await page.evaluate(
        ({ key, stored }) => localStorage.setItem(`appstrate-view-${key}`, stored),
        { key: screen.key, stored },
      );
      await page.reload();
      await expect(stored === '"table"' ? table : cards).toHaveAttribute("data-state", "active");
    }
    await table.focus();
    await page.keyboard.press("Enter");
    await expect(table).toHaveAttribute("data-state", "active");
    await page.reload();
    await expect(table).toHaveAttribute("data-state", "active");
    // A choice on either new grid must not change another index's default.
    await page.goto("/agents");
    await expect(page.getByRole("tab", { name: "Vue tableau", exact: true })).toHaveAttribute(
      "data-state",
      "active",
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
  await page.goto("/integrations?execution=local");
  const link = page.getByRole("link", { name: `Test Integration ${name}`, exact: true });
  await expect(link).toBeVisible();
  await expect(page.getByText(/0 connexion/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("integrations-grid-mobile.png"),
    fullPage: true,
  });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/integrations/${scope}/${name}$`));
  await expect(page.getByRole("tab", { name: /Vue d[’']ensemble/ })).toBeVisible();
});
