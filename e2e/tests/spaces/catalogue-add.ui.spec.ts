// SPDX-License-Identifier: Apache-2.0

/**
 * A Découvrir card's « Ajouter » adds where the reader works. With a space selected, it posts to
 * that space in one click and turns into « Ajouté ». In « Tous les espaces » no space is the
 * context: the same card opens the menu of spaces, those where the package already runs ticked
 * and inert, and adding to one posts to THAT space, never the hidden working one.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

/** A Découvrir card, by its title: the innermost block holding the title and the add slot. */
function catalogueCard(page: Page, displayName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: displayName, exact: true }) })
    .filter({ hasText: /Ajout/ })
    .last();
}

test("« Ajouter » adds to the working space, and in « Tous les espaces » to the space picked", async ({
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `cat-${Date.now().toString(36)}`;
  const displayName = `Test Agent ${name}`;
  const alpha = await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  const beta = await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  // Authored, and so running, in Alpha only.
  await createAgent(apiClient.withSpace(alpha.id), scope, name);
  const addedTo = (page: Page) =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/spaces\/[^/]+\/packages$/.test(response.url()),
    );

  // ── In Beta: one click, posted to Beta, then « Ajouté » ──
  const inBeta = await (
    await createAuthedContext(browser, browserCtx.auth, orgId, beta.id)
  ).newPage();
  try {
    await inBeta.goto("/catalogue/agent");
    const card = catalogueCard(inBeta, displayName);
    const add = card.getByRole("button", { name: "Ajouter", exact: true });
    await expect(add).toBeVisible();
    await expect(card.getByRole("button", { name: /^Ajouter/ })).toHaveCount(1);
    const posted = addedTo(inBeta);
    await add.click();
    const response = await posted;
    expect(new URL(response.url()).pathname).toBe(`/api/spaces/${beta.id}/packages`);
    expect(response.request().postDataJSON()).toEqual({ packageId: `${scope}/${name}` });
    expect(response.status()).toBe(201);
    await expect(card.getByText("Ajouté", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /^Ajouter/ })).toHaveCount(0);
  } finally {
    await inBeta.context().close();
  }

  // ── In « Tous les espaces » over Default: the menu of spaces, the pick is where it lands ──
  const context = await createOverviewContext(
    browser,
    browserCtx.auth,
    orgId,
    browserCtx.org.defaultSpaceId,
  );
  const page = await context.newPage();
  try {
    await page.goto("/catalogue/agent");
    const card = catalogueCard(page, displayName);
    // It runs in Alpha and Beta: the trigger asks the space and counts those.
    const trigger = card.getByRole("button", { name: /^Ajouter à…/ });
    await expect(trigger).toHaveAccessibleName(/\b2 espaces$/);
    await trigger.click();
    const menu = page.getByRole("menu").filter({ hasText: "Ajouter à…" });
    await expect(menu).toBeVisible();
    const entry = (spaceName: string) => menu.getByRole("menuitem").filter({ hasText: spaceName });
    // Where it runs: ticked and inert.
    for (const running of [alpha.name, beta.name]) {
      await expect(entry(running)).toHaveAttribute("data-disabled", "");
      await expect(entry(running)).toContainText("Actif");
    }
    // Where it may be added: offered.
    await expect(entry("Default")).not.toHaveAttribute("data-disabled", "");
    await expect(entry("Default")).not.toContainText("Actif");

    const posted = addedTo(page);
    await entry("Default").click();
    const response = await posted;
    expect(new URL(response.url()).pathname).toBe(
      `/api/spaces/${browserCtx.org.defaultSpaceId}/packages`,
    );
    expect(response.status()).toBe(201);
    // The count follows: it runs in three spaces now.
    await expect(trigger).toHaveAttribute("title", /\b3 espaces$/);
  } finally {
    await context.close();
  }

  // Placed and on in Default now.
  const placed = await apiClient.get(`/spaces/${browserCtx.org.defaultSpaceId}/packages`);
  expect(placed.status()).toBe(200);
  const row = ((await placed.json()).data as { packageId: string; enabled?: boolean }[]).find(
    (candidate) => candidate.packageId === `${scope}/${name}`,
  );
  expect(row).toBeDefined();
  expect(row?.enabled).not.toBe(false);
});
