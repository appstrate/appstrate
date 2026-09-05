// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";

test("OAuth signup assignments survive create, edit, and temporary role changes", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const space = await createSpace(orgOnlyClient, `Signup space ${Date.now()}`);
  const enabled = await orgOnlyClient.put(`/orgs/${browserCtx.org.orgId}/settings`, {
    dashboard_sso_enabled: true,
  });
  expect(enabled.status()).toBe(200);
  await page.goto("/org-settings/oauth");
  await page
    .getByRole("button", { name: /Nouveau client|New client/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const name = `Signup client ${Date.now()}`;
  await dialog.locator("#oauth-client-name").fill(name);
  await dialog
    .getByPlaceholder("https://example.com/oauth/callback")
    .fill("https://example.com/callback");
  await dialog.locator("#oauth-client-signup-role").selectOption("guest");
  // The signup policy is valid even while signup is disabled, so preparing a
  // guest configuration still requires a space before it can be persisted.
  await dialog.getByRole("button", { name: /Nouveau client|New client/i }).click();
  await expect(
    dialog.getByText(/pick at least one space|au moins un espace/i).last(),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: /Ajouter un espace|Add a space/i }).click();
  await page.getByRole("option", { name: space.name, exact: true }).click();
  const role = dialog.getByRole("combobox", { name: new RegExp(space.name) });
  await role.click();
  await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/oauth/clients"),
  );
  await dialog.getByRole("button", { name: /Nouveau client|New client/i }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const client = await created.json();
  expect(client).toMatchObject({
    signupRole: "guest",
    allowSignup: false,
    signupSpaceAssignments: [{ space_id: space.id, preset_role: "viewer" }],
  });
  await page.keyboard.press("Escape");

  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await row.getByTitle(/Modifier|Edit/).click();
  await expect(dialog.locator("#oauth-client-signup-role")).toHaveValue("guest");
  await expect(dialog.getByRole("combobox", { name: new RegExp(space.name) })).toContainText(
    /Lecteur|Viewer/,
  );
  await dialog.locator("#oauth-client-signup-role").selectOption("admin");
  await expect(dialog.getByRole("combobox", { name: new RegExp(space.name) })).toHaveCount(0);
  await dialog.locator("#oauth-client-signup-role").selectOption("guest");
  await expect(dialog.getByRole("combobox", { name: new RegExp(space.name) })).toContainText(
    /Lecteur|Viewer/,
  );
  await dialog.locator("#oauth-client-signup-role").selectOption("admin");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/oauth/clients/${client.clientId}`),
  );
  await dialog.getByRole("button", { name: /Enregistrer|Save/ }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ signupRole: "admin", signupSpaceAssignments: [] });
});
