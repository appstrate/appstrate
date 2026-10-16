// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("settings never write on typing, blur, delay or cancel; a refused save keeps the draft", async ({
  authedPage: page,
  browserCtx,
}) => {
  const path = `/api/spaces/${browserCtx.org.defaultSpaceId}`;
  const writes: unknown[] = [];
  let refuse = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    if (refuse)
      return route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Invalid input",
          detail: "Rejected",
          status: 400,
          code: "invalid_request",
        }),
      });
    return route.continue();
  });
  await page.goto("/workspace-settings/general");
  const name = page.getByRole("textbox", { name: "Nom", exact: true });
  const original = await name.inputValue();
  await name.fill("Not saved");
  await name.blur();
  // Longer than the retired debounce; an idle page must not send a write.
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Annuler les modifications", exact: true }).click();
  await expect(name).toHaveValue(original);
  expect(writes).toEqual([]);
  await name.fill("Manual name");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ }).last()).toBeVisible();
  await expect(name).toHaveValue("Manual name");
  expect(writes).toEqual([{ name: "Manual name" }]);
  refuse = false;
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(path) && response.request().method() === "PATCH" && response.ok(),
  );
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("Manual name");
});

test("two dirty preferences remain guarded, and a failed save prevents navigation", async ({
  authedPage: page,
}) => {
  let writes = 0;
  let refuse = true;
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    if (refuse)
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Unavailable",
          detail: "Retry",
          status: 500,
        }),
      });
    return route.continue();
  });
  await page.goto("/preferences/appearance");
  const selects = page.getByRole("combobox");
  await selects.nth(0).click();
  await page.getByRole("option", { name: "Sombre", exact: true }).click();
  await selects.nth(1).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  expect(writes).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("appstrate-theme"))).not.toBe("dark");
  await page.getByRole("link", { name: "Général", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Modifications non enregistrées" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  // The language form still guards the destination after the theme's decision.
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/appearance/);
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Enregistrer", exact: true }).first().click();
  expect(await page.evaluate(() => localStorage.getItem("appstrate-theme"))).toBe("dark");
  await page.getByRole("link", { name: "Général", exact: true }).click();
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/preferences\/appearance/);
  expect(writes).toBe(1);
  await expect(selects.nth(1)).toHaveText("English");
  refuse = false;
  await page.getByRole("link", { name: "Général", exact: true }).click();
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/general/);
  expect(writes).toBe(2);
});
