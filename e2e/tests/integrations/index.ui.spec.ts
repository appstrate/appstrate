// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations page is the organization's inventory, driven from the
 * browser: the system integrations the space runs, and every custom one the
 * organization owns, switched on here or not (RBAC spec §6.8).
 *
 * It reads the whole management listing (`GET /api/integrations`) and tells the
 * two states apart with a Statut column, so a custom integration switched off in
 * this space is still a row, marked « Non activée », instead of vanishing: the
 * page is where you manage them, not just where you find what is running.
 *
 * The row and the search box read the same manifest projection the route emits
 * (`display_name`, `description`, `keywords`), so a keyword that appears nowhere
 * in the name still finds its integration.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration, deactivatePackageInSpace } from "../../helpers/seed.ts";

test("the integrations page lists the organization's integrations with their status, and searches manifest keywords", async ({
  authedPage: page,
  apiClient,
  browserCtx,
  orgOnlyClient,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const tag = Date.now().toString(36);
  const running = `ui-int-on-${tag}`;
  const switchedOff = `ui-int-off-${tag}`;
  // A keyword that shares nothing with either id or display name: only a search
  // that reads `keywords` can find it.
  const keyword = `pelican${tag}`;

  // Creating a package homes it here AND switches it on here, for every type.
  await createIntegration(apiClient, scope, running, { keywords: [keyword] });
  await createIntegration(apiClient, scope, switchedOff);
  // Switching it off leaves the placement and its settings in place: the page
  // keeps the row and marks it « Non activée ».
  await deactivatePackageInSpace(orgOnlyClient, browserCtx.org.defaultSpaceId, scope, switchedOff);

  const row = (name: string) =>
    page.getByRole("row").filter({ hasText: `Test Integration ${name}` });

  // The route the page asks is the assertion: the management listing.
  const listing = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/integrations",
  );
  // Custom integrations run in a sandbox: they sit under the « Locales » tab.
  await page.goto("/integrations?execution=local");
  expect((await listing).status()).toBe(200);

  // The row carries the manifest's display name, not the bare package id.
  await expect(row(running)).toBeVisible();
  await expect(row(running).getByRole("cell", { name: "Activée", exact: true })).toBeVisible();
  await expect(row(switchedOff)).toBeVisible();
  await expect(
    row(switchedOff).getByRole("cell", { name: "Non activée", exact: true }),
  ).toBeVisible();

  await page.getByRole("textbox", { name: /Rechercher des intégrations/ }).fill(keyword);
  await expect(row(running)).toBeVisible();
  await expect(row(switchedOff)).toHaveCount(0);

  // A query that matches nothing empties the list rather than falling back to
  // the unfiltered one.
  await page
    .getByRole("textbox", { name: /Rechercher des intégrations/ })
    .fill(`no-such-integration-${tag}`);
  await expect(row(running)).toHaveCount(0);
});
