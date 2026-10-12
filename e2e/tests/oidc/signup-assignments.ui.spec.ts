// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { openRowMenuItem } from "../../helpers/table.ts";

test("OAuth signup assignments survive create, edit, and temporary role changes", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const space = await createSpace(orgOnlyClient, `Signup space ${Date.now()}`);
  const enabled = await orgOnlyClient.patch(`/orgs/${browserCtx.org.orgId}/settings`, {
    dashboard_sso_enabled: true,
  });
  expect(enabled.status()).toBe(200);
  await page.goto("/org-settings/oauth");
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Nouveau client|New client/i }).click();
  const dialog = page.getByRole("dialog", {
    name: /Enregistrer un client OAuth|Register an OAuth client/i,
  });
  const name = `Signup client ${Date.now()}`;
  await dialog.locator("#oauth-client-name").fill(name);
  await dialog
    .getByPlaceholder("https://example.com/oauth/callback")
    .fill("https://example.com/callback");
  await dialog.locator("#oauth-client-signup-role").selectOption("guest");
  await dialog
    .getByRole("combobox", {
      name: /Sélectionner un espace|Select a space/i,
    })
    .click();
  await page.getByRole("option", { name: space.name, exact: true }).click();
  const role = dialog.getByRole("combobox", { name: new RegExp(space.name) });
  await role.click();
  await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/oauth/clients"),
  );
  await dialog.getByRole("button", { name: /^(Enregistrer|Register|Save)$/ }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const client = await created.json();
  expect(client).toMatchObject({
    signupRole: "guest",
    allowSignup: false,
    signupSpaceAssignments: [{ spaceId: space.id, preset_role: "viewer" }],
  });
  await page.keyboard.press("Escape");

  await openRowMenuItem(page, name, "Modifier");
  // The edit modal replaces the creation one: found by the field it carries.
  const editDialog = page
    .getByRole("dialog")
    .filter({ has: page.locator("#oauth-client-signup-role") });
  await expect(editDialog.locator("#oauth-client-signup-role")).toHaveValue("guest");
  await expect(editDialog.getByRole("combobox", { name: new RegExp(space.name) })).toContainText(
    /Lecteur|Viewer/,
  );
  await editDialog.locator("#oauth-client-signup-role").selectOption("admin");
  const allSpaces = editDialog.getByRole("textbox", { name: /^Espaces$|^Spaces$/ });
  await expect(allSpaces).toBeDisabled();
  await expect(allSpaces).toHaveValue(/Tous les espaces.*tous les droits|All spaces.*full access/i);
  await editDialog.locator("#oauth-client-signup-role").selectOption("guest");
  await expect(editDialog.getByRole("combobox", { name: new RegExp(space.name) })).toContainText(
    /Lecteur|Viewer/,
  );
  await editDialog.locator("#oauth-client-signup-role").selectOption("admin");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/oauth/clients/${client.clientId}`),
  );
  await editDialog.getByRole("button", { name: /Enregistrer|Save/ }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ signupRole: "admin", signupSpaceAssignments: [] });
});
