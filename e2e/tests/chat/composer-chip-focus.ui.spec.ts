// SPDX-License-Identifier: Apache-2.0

/**
 * A composer chip's X removes the control that held the focus: the focus moves to the control now
 * at the chip's place in its row (the next chip), else the one before it (the settings button at
 * worst), also when the chip leaves only once its request lands (a lifted limit).
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

test("a chip's X hands the focus to the next chip, then back to the settings button", async ({
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  const created = await orgOnlyClient.post(`/orgs/${orgId}/chat/sessions`, { title: "Focus" });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const context = await createOverviewContext(
    browser,
    browserCtx.auth,
    orgId,
    browserCtx.org.defaultSpaceId,
  );
  const page = await context.newPage();
  try {
    await page.goto(`/chat/${id}`);
    await expect(page.locator("[data-trail]")).toContainText("Focus");
    // Two settings off their default: two chips, creation first.
    const settings = page.getByTestId("composer-settings-trigger");
    await settings.click();
    const panel = page.getByTestId("composer-panel");
    await panel.getByRole("switch", { name: "Mode création" }).click();
    await panel.getByTestId("composer-context-all-spaces-item").click();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    const creationChip = page.getByTestId("composer-creation-chip");
    const contextChip = page.getByTestId("composer-context-all-spaces-off-chip");
    await expect(creationChip).toBeVisible();
    await expect(contextChip).toBeVisible();

    // From the keyboard: the first chip's X leaves the focus on the chip that took its place.
    await page.getByRole("button", { name: "Réactiver le mode création" }).focus();
    await page.keyboard.press("Enter");
    await expect(creationChip).toHaveCount(0);
    await expect(contextChip).toBeFocused();
    // The last chip's X: nothing after it, the settings button before it takes the focus.
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Détailler de nouveau tous les espaces" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(contextChip).toHaveCount(0);
    await expect(settings).toBeFocused();
  } finally {
    await context.close();
  }
});

test("lifting a limit from its chip keeps the focus once the request lands", async ({
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const spaceId = browserCtx.org.defaultSpaceId;
  await createSpace(orgOnlyClient, `Gamma ${Date.now()}`);
  const created = await orgOnlyClient.post(`/orgs/${orgId}/chat/sessions`, {
    title: "Limitée",
    spaceId,
    restricted: true,
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const context = await createOverviewContext(browser, browserCtx.auth, orgId, spaceId);
  const page = await context.newPage();
  try {
    await page.goto(`/chat/${id}`);
    const chip = page.getByTestId("composer-limit-chip");
    await expect(chip).toBeVisible();
    await page.getByRole("button", { name: /^Lever la limite/ }).focus();
    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().endsWith(`/sessions/${id}`),
    );
    await page.keyboard.press("Enter");
    expect((await patched).status()).toBe(204);
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("composer-settings-trigger")).toBeFocused();
  } finally {
    await context.close();
  }
});
