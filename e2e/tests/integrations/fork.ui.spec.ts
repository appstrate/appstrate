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

import { createOverviewContext } from "../../helpers/overview.ts";
import { createSpace } from "../../helpers/seed.ts";
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
  await page.getByRole("button", { name: "Actions", exact: true }).click();
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

test("a fork from Tous les espaces keeps the destination until the copy opens there", async ({
  browser,
  browserCtx,
  orgOnlyClient,
  apiClient,
}) => {
  const { orgId, orgSlug, defaultSpaceId } = browserCtx.org;
  const target = await createSpace(orgOnlyClient, `Studio ${Date.now()}`);
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
  const name = `slack-across-${Date.now().toString(36)}`;
  const id = `@${orgSlug}/${name}`;
  try {
    const page = await context.newPage();
    await page.goto(`/integrations/${SOURCE}`);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Dupliquer dans…" }).hover();
    await page.getByRole("menuitem", { name: target.name, exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Dupliquer le package" });
    await expect(dialog.getByText(target.name, { exact: true })).toBeVisible();
    await dialog.getByLabel("Nom du package").fill(name);
    const fork = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        decodeURIComponent(new URL(response.url()).pathname) === `/api/packages/${SOURCE}/fork`,
    );
    await dialog.getByRole("button", { name: "Dupliquer" }).click();
    const response = await fork;
    expect(response.request().headers()["x-space-id"]).toBe(target.id);
    expect(response.status()).toBe(201);
    await expect(page).toHaveURL(new RegExp(`/integrations/${id}$`));
    const copy = await apiClient.withSpace(target.id).get(`/packages/integrations/${id}`);
    expect(await copy.json()).toMatchObject({ id, home_space_id: target.id, forked_from: SOURCE });
  } finally {
    await context.close();
  }
});
