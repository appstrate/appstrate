// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations page is an INDEX, driven from the browser (RBAC spec §6.8).
 *
 * It asks the index route the other three type pages ask — the active set of
 * this space — so a package switched off here is absent because the SERVER
 * left it out, not because the page filtered a wider listing. That distinction
 * is invisible to a route test: only the rendered list shows which set reached
 * the screen.
 *
 * The row and the search box read the projection the route emits (`name`,
 * `description`, `keywords`, `source_kind`), so a keyword that appears nowhere
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

  // The route the page asks is the assertion: the index, which leaves the
  // switched-off integration out.
  const indexRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/packages/integrations",
  );
  // Custom integrations run in a sandbox: they sit under the « Locales » tab.
  await page.goto("/integrations?execution=local");
  const listed = await indexRead;
  expect(listed.status()).toBe(200);
  const { data } = (await listed.json()) as { data: { id: string; source_kind: string }[] };
  const ids = data.map((entry) => entry.id);
  expect(ids).toContain(`${scope}/${running}`);
  expect(ids).not.toContain(`${scope}/${switchedOff}`);
  expect(data.find((entry) => entry.id === `${scope}/${running}`)?.source_kind).toBe("local");

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
