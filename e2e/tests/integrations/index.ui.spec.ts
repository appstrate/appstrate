// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations page is an INDEX, driven from the browser (RBAC spec §6.8).
 *
 * It asks the index route the other three type pages ask — the active set of
 * this space, paginated server-side — so a package switched off here is absent
 * because the SERVER left it out, not because the page filtered a catalogue
 * page it had already truncated. That distinction is invisible to a route test:
 * only the rendered grid shows which set reached the screen.
 *
 * The card and the search box read the same manifest projection the route
 * emits (`icon`, `name`, `description`, `keywords`), so a keyword that appears
 * nowhere in the name still finds its integration.
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

  const card = (name: string) => page.locator(`[data-integration-id="${scope}/${name}"]`);

  // The route the page asks is the assertion: the index, not the catalogue.
  const indexRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/packages/integrations",
  );
  await page.goto("/integrations");
  expect((await indexRead).status()).toBe(200);

  await expect(card(running)).toBeVisible();
  await expect(card(switchedOff)).toHaveCount(0);

  // The card carries the manifest's display name, not the bare package id.
  await expect(card(running)).toContainText(`Test Integration ${running}`);

  await page.getByTestId("integrations-search").fill(keyword);
  await expect(card(running)).toBeVisible();

  // A query that matches nothing empties the grid rather than falling back to
  // the unfiltered list.
  await page.getByTestId("integrations-search").fill(`no-such-integration-${tag}`);
  await expect(card(running)).toHaveCount(0);
});
