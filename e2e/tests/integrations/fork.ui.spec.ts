// SPDX-License-Identifier: Apache-2.0

/**
 * Duplicating a system integration from its detail page.
 *
 * A fork re-validates the source version's manifest against the integration
 * write policy (a camelCase identity-claim key is refused, see
 * `assertManifestConforms`), so the everyday case has to keep working: a
 * conforming system integration forks, the SPA lands on the copy, and the copy
 * is an org-owned package that remembers where it came from.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

const SOURCE = "@appstrate/slack";

test("a system integration forks from its detail page into the org's scope", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `slack-copy-${Date.now().toString(36)}`;

  await page.goto(`/integrations/${SOURCE}`);
  await page.getByRole("button", { name: "Actions du package" }).click();
  await page.getByRole("menuitem", { name: "Dupliquer" }).click();

  const dialog = page.getByRole("dialog", { name: "Dupliquer le package" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nom du package").fill(name);
  await expect(dialog.getByText(`${scope}/${name}`)).toBeVisible();

  const forked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      decodeURIComponent(new URL(response.url()).pathname) === `/api/packages/${SOURCE}/fork`,
  );
  await dialog.getByRole("button", { name: "Dupliquer" }).click();
  const response = await forked;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ name });
  expect(await response.json()).toMatchObject({
    id: `${scope}/${name}`,
    forked_from: SOURCE,
  });

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/integrations/${scope}/${name}$`));

  const res = await apiClient.get(`/packages/integrations/${scope}/${name}`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    id: `${scope}/${name}`,
    source: "local",
    forked_from: SOURCE,
  });
});
