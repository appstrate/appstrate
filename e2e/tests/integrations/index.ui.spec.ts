// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations page is an INDEX, driven from the browser (RBAC spec §6.8):
 * the integrations this space runs. A custom integration switched off here keeps
 * its placement — the space library still lists it — and leaves the index.
 *
 * The page reads every page of the management listing (`GET /api/integrations`)
 * and keeps the active rows, so the switched-off row is absent from a listing
 * that did carry it, not from a truncated one.
 *
 * The row and the search box read the same manifest projection the route emits
 * (`display_name`, `description`, `keywords`), so a keyword that appears nowhere
 * in the name still finds its integration.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration, deactivatePackageInSpace } from "../../helpers/seed.ts";

test("the integrations index shows what this space runs, and searches manifest keywords", async ({
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
  // Switching it off leaves the placement and its settings in place — the space
  // library still lists it — and takes it out of the index.
  await deactivatePackageInSpace(orgOnlyClient, browserCtx.org.defaultSpaceId, scope, switchedOff);

  const row = (name: string) =>
    page.getByRole("row").filter({ hasText: `Test Integration ${name}` });

  // The management listing carries both rows; the index shows the active one.
  const listing = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/integrations",
  );
  // Custom integrations run in a sandbox: they sit under the « Locales » tab.
  await page.goto("/integrations?execution=local");
  const listed = await listing;
  expect(listed.status()).toBe(200);
  const { data } = (await listed.json()) as { data: { id: string; active: boolean }[] };
  expect(data.find((entry) => entry.id === `${scope}/${switchedOff}`)?.active).toBe(false);

  // The row carries the manifest's display name, not the bare package id.
  await expect(row(running)).toBeVisible();
  await expect(row(switchedOff)).toHaveCount(0);

  await page.getByRole("textbox", { name: /Rechercher des intégrations/ }).fill(keyword);
  await expect(row(running)).toBeVisible();

  // A query that matches nothing empties the list rather than falling back to
  // the unfiltered one.
  await page
    .getByRole("textbox", { name: /Rechercher des intégrations/ })
    .fill(`no-such-integration-${tag}`);
  await expect(row(running)).toHaveCount(0);
});
