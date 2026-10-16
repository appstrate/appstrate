// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration } from "../../helpers/seed.ts";

test("column width and language changes persist only after Save, including a width reset", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  await createIntegration(apiClient, `@${browserCtx.org.orgSlug}`, `widths-${Date.now()}`);
  await page.goto("/integrations?execution=local");
  await page.getByRole("tab", { name: "Vue tableau", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  const table = page.getByRole("table", { name: "Intégrations de l'organisation", exact: true });
  const head = table.locator('th[data-column="name"]');
  await expect(head).toBeVisible();
  const handle = head.getByRole("separator");
  const box = await handle.boundingBox();
  if (!box) throw new Error("The resize handle has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  const widthKey = "appstrate-column-widths-integrations";
  const savedWidth = () =>
    page.evaluate((key) => {
      const widths = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>;
      return widths.name;
    }, widthKey);
  expect(await savedWidth()).toBeUndefined();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect.poll(savedWidth).toBeGreaterThan(0);
  const width = await savedWidth();
  await expect(head).toHaveCSS("width", `${width}px`);

  await page.goto("/preferences/appearance");
  await page.getByRole("combobox", { name: "Langue", exact: true }).click();
  const savedLanguage = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === "/api/profile",
  );
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  expect((await savedLanguage).status()).toBe(200);
  await page.goto("/integrations?execution=local");
  const englishHead = page
    .getByRole("table", { name: "Organization integrations", exact: true })
    .locator('th[data-column="name"]');
  await expect(englishHead).toHaveCSS("width", `${width}px`);
  await englishHead.getByRole("separator").dblclick();
  expect(await savedWidth()).toBe(width);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(savedWidth).toBeUndefined();
});
