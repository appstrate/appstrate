// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "../../fixtures/browser.fixture.ts";

test.describe("chat actions on a touchscreen", () => {
  test.use({ hasTouch: true });

  test("copy and conversation actions work in landscape and in the portrait drawer", async ({
    authedPage: page,
    orgOnlyClient,
    browserCtx,
  }, testInfo) => {
    const sessions = `/orgs/${browserCtx.org.orgId}/chat/sessions`;
    const created = await orgOnlyClient.post(sessions, {
      title: "Budget",
      restricted: true,
      spaceId: browserCtx.org.defaultSpaceId,
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    // A saved answer exercises the real Copy action without a model call.
    await page.route(
      `**/api${sessions}/${id}`,
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: {
            ...(await response.json()),
            messages: [
              {
                id: "answer",
                content: { role: "assistant", parts: [{ type: "text", text: "Budget vérifié." }] },
              },
            ],
          },
        });
      },
      { times: 1 },
    );
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(`/chat/${id}`);
    await page.getByRole("textbox", { name: "Message Appstrate…", exact: true }).tap();
    const chip = page.getByTestId("composer-limit-chip");
    const lift = chip.getByRole("button", { name: /^Lever la limite/ });
    await expect(lift).toHaveCSS("width", "40px");
    await expect(lift).toHaveCSS("height", "40px");
    const hit = await lift.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return [box.left + 2, box.right - 2].every((x) =>
        button.contains(document.elementFromPoint(x, box.top + box.height / 2)),
      );
    });
    expect(hit).toBe(true);
    const copy = page.getByRole("button", { name: "Copier", exact: true });
    await expect(copy).toHaveCSS("width", "40px");
    await expect(copy.locator("..")).toHaveCSS("opacity", "1");
    await copy.tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Budget vérifié.");
    const menu = page.getByTestId("sheet-menu");
    const trigger = page.getByRole("button", { name: "Actions de « Budget »" });
    await expect(trigger).toHaveCSS("width", "44px");
    await trigger.tap();
    // From `md` up the "…" opens a dropdown, whatever the pointer; the same two items.
    await expect(page.getByRole("menuitem", { name: "Supprimer", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Renommer", exact: true }).tap();
    const rename = page.getByRole("dialog", { name: "Renommer la conversation" });
    const name = rename.getByRole("textbox", { name: "Nom", exact: true });
    await expect(name).toBeFocused();
    await name.fill("Budget validé");
    await rename.getByRole("button", { name: "Renommer", exact: true }).tap();
    const renamed = page.getByRole("button", { name: "Actions de « Budget validé »" });
    await expect(renamed).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("landscape.png"), animations: "disabled" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("chat-sidebar-trigger").tap();
    // Below `md` the same "…" opens a panel from the bottom: its rows are buttons.
    await renamed.tap();
    await expect(menu.getByRole("button", { name: "Renommer", exact: true })).toBeVisible();
    const remove = menu.getByRole("button", { name: "Supprimer", exact: true });
    await expect(remove).toHaveCSS("min-height", "48px");
    await page.screenshot({ path: testInfo.outputPath("menu.png"), animations: "disabled" });
    await remove.tap();
    const dialog = page.getByRole("alertdialog");
    const cancel = dialog.getByRole("button", { name: "Annuler" });
    await expect(cancel).toBeFocused();
    await cancel.tap();
    await expect(renamed).toBeFocused();
    await renamed.tap();
    await remove.tap();
    await dialog.getByRole("button", { name: "Supprimer" }).tap();
    await expect(renamed).toHaveCount(0);
    await expect
      .poll(async () => (await orgOnlyClient.get(`${sessions}/${id}`)).status())
      .toBe(404);
  });
});

test("a keyboard user sees the focused conversation action and returns to it", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const created = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/chat/sessions`, {
    title: "Budget clavier",
  });
  expect(created.status()).toBe(201);
  await page.goto("/chat");
  const row = page.getByRole("button", { name: /^Budget clavier/ });
  await row.focus();
  await page.keyboard.press("Tab");
  const actions = page.getByRole("button", { name: "Actions de « Budget clavier »" });
  await expect(actions).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Renommer", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Nom", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
});
