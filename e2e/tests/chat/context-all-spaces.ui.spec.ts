// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's every-space context: on by default, its explanation behind an ⓘ beside the label
 * rather than under it, and a chip once it is off, whose X details every space again (#2434).
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

test("the every-space context is on by default and explains itself behind an ⓘ", async ({
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  // A second space: the switch is offered only to a conversation that can act in several.
  await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  const created = await orgOnlyClient.post(`/orgs/${orgId}/chat/sessions`, { title: "Contexte" });
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
    await expect(page.locator("[data-trail]")).toContainText("Contexte");
    const chip = page.getByTestId("composer-context-all-spaces-off-chip");
    await expect(chip).toHaveCount(0);

    await page.getByTestId("composer-settings-trigger").click();
    const panel = page.getByTestId("composer-panel");
    const toggle = panel.getByTestId("composer-context-all-spaces-item");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAccessibleName("Contexte de tous les espaces");
    // The explanation is not a line of the panel: it describes the switch, and the ⓘ shows it.
    const hint = /L’assistant connaît d’emblée les intégrations et les agents/;
    await expect(toggle).toHaveAccessibleDescription(hint);
    await expect(panel.getByText(hint)).toBeHidden();
    const info = panel.getByTestId("composer-context-all-spaces-item-info");
    await info.click();
    const bubble = page.getByRole("tooltip").filter({ hasText: hint });
    await expect(bubble).toBeVisible();
    // Escape closes the bubble alone; the click on the ⓘ toggled nothing.
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Off: the composer says the context is reduced; the chip's X details every space again.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Contexte réduit");
    await page.getByRole("button", { name: "Détailler de nouveau tous les espaces" }).click();
    await expect(chip).toHaveCount(0);
    await page.getByTestId("composer-settings-trigger").click();
    await expect(page.getByTestId("composer-context-all-spaces-item")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  } finally {
    await context.close();
  }
});
