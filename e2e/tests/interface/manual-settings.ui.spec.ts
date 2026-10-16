// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createOrg, createSpace, createAgentWithInputSchema } from "../../helpers/seed.ts";
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
  await expect(page.getByRole("alert").filter({ hasText: /./ }).last()).toBeVisible();
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

test("the theme applies at once, the language waits for Save and a failed save prevents navigation", async ({
  authedPage: page,
}) => {
  let writes = 0;
  let refuse = true;
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    if (refuse)
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Unavailable",
          detail: "Retry",
          status: 500,
        }),
      });
    return route.continue();
  });
  await page.goto("/preferences/appearance");
  const theme = page.getByRole("combobox", { name: "Thème", exact: true });
  const language = page.getByRole("combobox", { name: "Langue", exact: true });
  await theme.click();
  await page.getByRole("option", { name: "Sombre", exact: true }).click();
  // A display preference: applied and stored at once, no save bar.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("appstrate-theme")))
    .toContain("dark");
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await language.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  expect(writes).toBe(0);
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Général", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/appearance/);
  expect(writes).toBe(0);
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Général", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/preferences\/appearance/);
  expect(writes).toBe(1);
  await expect(language).toHaveText("English");
  refuse = false;
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Général", exact: true })
    .click();
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

test("switching organizations drops the draft instead of saving it into the next one", async ({
  authedPage: page,
  browserCtx,
  request,
}) => {
  const next = await createOrg(request, browserCtx.auth.cookie);
  await page.goto("/org-settings/general");
  const name = page.getByRole("textbox", { name: "Nom", exact: true });
  await expect(name).toHaveValue(browserCtx.org.orgName);
  await name.fill("Draft made in the first organization");
  await page.getByRole("combobox", { name: "Choisir une organisation", exact: true }).click();
  await page.getByRole("option", { name: next.orgName, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(name).toHaveValue(next.orgName);
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  const orgs = await request.get("/api/orgs", { headers: { Cookie: browserCtx.auth.cookie } });
  const names = ((await orgs.json()).data as Array<{ name: string }>).map((org) => org.name);
  expect(names).toContain(next.orgName);
  expect(names).not.toContain("Draft made in the first organization");
});

test("browser Back can be cancelled without unmounting the edited form", async ({
  authedPage: page,
}) => {
  await page.goto("/preferences/general");
  await page
    .getByRole("navigation", { name: "Compte", exact: true })
    .getByRole("link", { name: "Apparence", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Langue", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toBeVisible();
  await page.goBack();
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(page).toHaveURL(/preferences\/appearance/);
  await expect(page.getByRole("combobox", { name: "Langue", exact: true })).toHaveText("English");
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(page).toHaveURL(/preferences\/general/);
});

test("a conversation rename stays with its target across guarded navigation", async ({
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
  await page.getByRole("button", { name: "Rename B", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Modifications non enregistrées" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(name).toHaveValue("Pending A");
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Rename B", exact: true }).click();
  await dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
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
