// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent, createAgentWithInputSchema } from "../../helpers/seed.ts";

for (const type of ["skill", "integration"] as const) {
  test(`${type}: creation keeps its values after a refusal and opens the saved package`, async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const name = `new-${type}-${Date.now()}`;
    await page.goto(`/${type}s?create=${type}`);
    await page.getByRole("button", { name: /Créer manuellement/ }).click();
    const dialog = page.getByRole("dialog", {
      name: type === "skill" ? "Nouveau skill" : "Nouvelle intégration",
    });
    await dialog.getByLabel("Nom d'affichage").fill(name);
    await dialog.getByLabel("Description").fill("Created from the short dialog");
    if (type === "skill")
      await dialog.getByLabel("Instructions de la skill").fill("Review each file.");
    else await dialog.getByLabel("URL du serveur distant").fill("https://example.com/mcp");
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/packages/${type}s`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push(route.request().postDataJSON());
      if (writes.length === 1)
        return route.fulfill({
          status: 400,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Invalid Request",
            status: 400,
            code: "invalid_request",
            detail: "Retry creation",
          }),
        });
      await route.continue();
    });
    await dialog.getByRole("button", { name: "Créer", exact: true }).click();
    await expect(dialog.getByText("Retry creation")).toBeVisible();
    await expect(dialog.getByLabel("Nom d'affichage")).toHaveValue(name);
    await dialog.getByRole("button", { name: "Créer", exact: true }).click();
    const id = `@${browserCtx.org.orgSlug}/${name}`;
    await expect(page).toHaveURL(`/${type}s/${id}`);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    if (type === "skill") {
      const response = await apiClient.get(`/packages/${id}/files/content?path=SKILL.md`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(`name: ${name}`);
    } else {
      const response = await apiClient.get(`/packages/integrations/${id}`);
      expect(response.status()).toBe(200);
      expect((await response.json()).manifest.auths.primary.authorized_uris).toEqual([
        "https://example.com/**",
      ]);
    }
    expect(errors).toEqual([]);
  });
}

test("closing a creation abandons its input without writing a package", async ({
  authedPage: page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/packages/"))
      writes.push(request.url());
  });
  await page.goto("/skills?create=skill");
  await page.getByRole("button", { name: /Créer manuellement/ }).click();
  const dialog = page.getByRole("dialog", { name: "Nouveau skill" });
  await dialog.getByLabel("Nom d'affichage").fill("Unsaved skill");
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Nouveau skill/ }).click();
  await page.getByRole("button", { name: /Créer manuellement/ }).click();
  await expect(dialog.getByLabel("Nom d'affichage")).toHaveValue("");
  expect(writes).toEqual([]);
});

test("schema reorder actions persist the order without losing field definitions", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const name = `reorder-${Date.now()}`;
  const scope = `@${browserCtx.org.orgSlug}`;
  await createAgentWithInputSchema(apiClient, scope, name, {
    first: { type: "string", description: "First field" },
    second: { type: "number" },
  });
  await page.goto(`/agents/${scope}/${name}?agentSettings=schema#settings`);
  await page
    .getByRole("row")
    .filter({ hasText: "first" })
    .getByRole("button", { name: "Actions pour first", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Descendre", exact: true }).click();
  const rows = page.getByRole("table").first().getByRole("row");
  await expect(rows.nth(1)).toContainText("second");
  await expect(rows.nth(2)).toContainText("first");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/packages/agents/${scope}/${name}`),
  );
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("table").first().getByRole("row").nth(1)).toContainText("second");
  const response = await apiClient.get(`/packages/agents/${scope}/${name}`);
  const manifest = (await response.json()).manifest;
  expect(manifest.input.property_order).toEqual(["second", "first"]);
  expect(manifest.input.schema.properties.first).toMatchObject({
    type: "string",
    description: "First field",
  });
});

test("organization role details remain readable without a matrix", async ({ authedPage: page }) => {
  await page.goto("/org-settings/roles");
  await page.getByRole("button", { name: "Membre", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Membre", exact: true });
  await expect(dialog.getByRole("listitem").first()).toBeVisible();
  await expect(page).toHaveURL(/orgRole=member/);
  await page.reload();
  await expect(dialog.getByRole("listitem").first()).toBeVisible();
});

test("the native time field writes the chosen clock time into a schedule's cron", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  await createAgent(apiClient, `@${browserCtx.org.orgSlug}`, `clock-${Date.now()}`);
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Nouvelle planification", exact: true }).click();
  await page.locator("#frequency-kind").click();
  await page.getByRole("option", { name: "Chaque jour", exact: true }).click();
  const clock = page.locator("#frequency-at");
  await expect(clock).toHaveAttribute("type", "time");
  await clock.fill("17:05");
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/schedules"),
  );
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().cron_expression).toBe("5 17 * * *");
});

test("package identity links work at desktop and phone widths in both themes", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `identity-${Date.now()}`;
  const scope = `@${browserCtx.org.orgSlug}`;
  await createAgent(apiClient, scope, name);
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/agents");
      const link = page.getByRole("link", { name: `Test Agent ${name}`, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", `/agents/${scope}/${name}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`agents-${width}-${theme}.png`),
        fullPage: true,
      });
      await link.click();
      await expect(page).toHaveURL(`/agents/${scope}/${name}`);
    }
  expect(errors).toEqual([]);
});
