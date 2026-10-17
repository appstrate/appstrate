// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import {
  activatePackageInSpace,
  createAgentWithInputSchema,
  createSpace,
} from "../../helpers/seed.ts";
import { Sidebar } from "../../pages/sidebar.ts";

test("settings never write on typing, blur, delay or cancel; a refused save keeps the draft", async ({
  authedPage: page,
  browserCtx,
}) => {
  const path = `/api/spaces/${browserCtx.org.defaultSpaceId}`;
  const writes: unknown[] = [];
  let refuse = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    if (refuse)
      return route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Invalid input",
          detail: "Rejected",
          status: 400,
          code: "invalid_request",
        }),
      });
    return route.continue();
  });
  await page.goto("/workspace-settings/general");
  const name = page.getByRole("textbox", { name: "Nom", exact: true });
  const original = await name.inputValue();
  await name.fill("Not saved");
  await name.blur();
  // An idle page must not send a write.
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Annuler les modifications", exact: true }).click();
  await expect(name).toHaveValue(original);
  expect(writes).toEqual([]);
  await name.fill("Manual name");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]").last()).toBeVisible();
  await expect(name).toHaveValue("Manual name");
  expect(writes).toEqual([{ name: "Manual name" }]);
  refuse = false;
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(path) && response.request().method() === "PATCH" && response.ok(),
  );
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await saved;
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("Manual name");
});

test("single choices apply at once, and a failed save from the leave dialog keeps the form", async ({
  authedPage: page,
  browserCtx,
}) => {
  await page.goto("/preferences/appearance");
  // A single choice is the command: no save bar.
  await page.getByRole("combobox", { name: "Thème", exact: true }).click();
  await page.getByRole("option", { name: "Sombre", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("appstrate-theme")))
    .toContain("dark");
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);

  const path = `/api/spaces/${browserCtx.org.defaultSpaceId}`;
  let writes = 0;
  let refuse = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    if (refuse)
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({ type: "about:blank", title: "Unavailable", status: 500 }),
      });
    return route.continue();
  });
  await page.goto("/workspace-settings/general");
  await page.getByRole("textbox", { name: "Nom", exact: true }).fill("Saved on leave");
  const leave = () =>
    page
      .getByRole("navigation", { name: "Compte", exact: true })
      .getByRole("link", { name: "Général", exact: true })
      .click();
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await leave();
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/workspace-settings\/general/);
  expect(writes).toBe(1);
  refuse = false;
  await leave();
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/general/);
  expect(writes).toBe(2);
});

test("switching spaces asks before discarding the current form", async ({
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  const target = await createSpace(orgOnlyClient, `Manual target ${Date.now()}`);
  await page.goto("/workspace-settings/general");
  const name = page.getByRole("textbox", { name: "Nom", exact: true });
  await name.fill("Unsaved space name");
  const sidebar = new Sidebar(page);
  await sidebar.switchSpaceInSettings(target.name);
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(name).toHaveValue("Unsaved space name");
  await sidebar.switchSpaceInSettings(target.name);
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(name).toHaveValue(target.name);
  const original = await orgOnlyClient.get(`/spaces/${browserCtx.org.defaultSpaceId}`);
  expect((await original.json()).name).not.toBe("Unsaved space name");
});

test("a form that outlives a space switch drops its draft and stays guarded", async ({
  authedPage: page,
  orgOnlyClient,
}) => {
  const target = await createSpace(orgOnlyClient, `Manual survivor ${Date.now()}`);
  await page.goto("/preferences/general");
  const name = page.getByRole("textbox", { name: "Nom d'affichage", exact: true });
  const original = await name.inputValue();
  const save = page.getByRole("button", { name: "Enregistrer", exact: true });
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await name.fill("Draft before the switch");
  await new Sidebar(page).switchSpaceInSettings(target.name);
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  // The account preference stays mounted: the draft is gone, not left unguarded.
  await expect(name).toHaveValue(original);
  await expect(save).toHaveCount(0);
  await name.fill("Draft after the switch");
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Apparence", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(name).toHaveValue("Draft after the switch");
});

test("switching spaces under a mounted agent page drops its draft instead of saving it into the next space", async ({
  authedPage: page,
  apiClient,
  orgOnlyClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `manual-scope-${Date.now()}`;
  await createAgentWithInputSchema(apiClient, scope, name, {
    destination: { type: "string", title: "Destination" },
  });
  const target = await createSpace(orgOnlyClient, `Manual scope ${Date.now()}`);
  await activatePackageInSpace(orgOnlyClient, target.id, `${scope}/${name}`);
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/input-settings"))
      writes.push(request.postDataJSON());
  });
  await page.goto(`/agents/${scope}/${name}?agentSettings=inputs#settings`);
  const destination = page.getByRole("textbox", { name: "Destination", exact: true });
  const save = page.getByRole("button", { name: "Enregistrer", exact: true });
  await destination.fill("Draft made in the first space");
  await expect(save).toBeVisible();
  // A space switch drops the space's caches (`selectSpace`), so the form unmounts with its draft.
  await new Sidebar(page).switchSpace(target.name);
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${scope}/${name}`));
  await expect(destination).toHaveValue("");
  await expect(save).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("browser Back can be cancelled without unmounting the edited form", async ({
  authedPage: page,
}) => {
  await page.goto("/preferences/appearance");
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Général", exact: true })
    .click();
  const name = page.getByRole("textbox", { name: "Nom d'affichage", exact: true });
  await name.fill("Unsaved display name");
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toBeVisible();
  await page.goBack();
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/general/);
  await expect(name).toHaveValue("Unsaved display name");
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(page).toHaveURL(/preferences\/appearance/);
});

test("leaving a conversation cancels its rename without asking, and a rename saves to its own target", async ({
  authedPage: page,
  apiClient,
}) => {
  const create = async (title: string) => {
    const response = await apiClient.post("/chat/sessions", { title });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const a = await create("Rename A");
  const b = await create("Rename B");
  const writes: { id: string; title: string }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/chat/sessions/")) {
      writes.push({
        id: new URL(request.url()).pathname.split("/").at(-1)!,
        title: request.postDataJSON().title,
      });
    }
  });
  await page.goto(`/chat/${a}`);
  const trail = page.locator("[data-trail]:visible");
  await trail.getByRole("button", { name: "Rename A", exact: true }).click();
  const name = trail.getByRole("textbox");
  await name.fill("Pending A");
  // A rename is a named action: leaving cancels it, no dialog, no write.
  await page.getByRole("button", { name: "Rename B", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${b}$`));
  await expect(trail.getByRole("textbox")).toHaveCount(0);
  await trail.getByRole("button", { name: "Rename B", exact: true }).click();
  await expect(name).toHaveValue("Rename B");
  await name.fill("Saved B");
  await trail.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(trail.getByRole("button", { name: "Saved B", exact: true })).toBeVisible();
  expect(writes).toEqual([{ id: b, title: "Saved B" }]);
  const original = await apiClient.get(`/chat/sessions/${a}`);
  expect((await original.json()).title).toBe("Rename A");
});

test("author defaults never dirty input settings, and Save sends only edited values with their locks", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `manual-defaults-${Date.now()}`;
  await createAgentWithInputSchema(apiClient, scope, name, {
    destination: { type: "string", title: "Destination", default: "Author destination" },
    attempts: { type: "integer", title: "Attempts", default: 2 },
    verbose: { type: "boolean", title: "Verbose", default: false },
    options: {
      type: "object",
      title: "Options",
      properties: { region: { type: "string", default: "eu" } },
    },
    tags: { type: "array", title: "Tags", items: { type: "string" }, minItems: 1 },
  });
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/input-settings"))
      writes.push(request.postDataJSON());
  });
  await page.goto(`/agents/${scope}/${name}?agentSettings=inputs#settings`);
  const destination = page.getByRole("textbox", { name: "Destination", exact: true });
  const save = page.getByRole("button", { name: "Enregistrer", exact: true });
  const lock = page
    .getByTestId("input-setting-destination")
    .getByRole("checkbox", { name: "Verrouiller", exact: true });
  await expect(destination).toBeVisible();
  await expect(save).toHaveCount(0);
  await destination.fill("Local draft");
  await lock.check();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Annuler les modifications", exact: true }).click();
  await expect(destination).toHaveValue("");
  await expect(lock).not.toBeChecked();
  await expect(save).toHaveCount(0);
  expect(writes).toEqual([]);
  await destination.fill("Saved destination");
  await lock.check();
  await save.click();
  await expect(save).toHaveCount(0);
  expect(writes).toEqual([
    { values: { destination: "Saved destination" }, locked_fields: ["destination"] },
  ]);
  await page.reload();
  await expect(destination).toHaveValue("Saved destination");
  await expect(lock).toBeChecked();
  await expect(save).toHaveCount(0);
});
