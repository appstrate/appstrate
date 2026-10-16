// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgentWithInputSchema, createIntegration } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../../apps/api/test/helpers/integration-manifests.ts";

test("keywords and authorization URIs retain their distinct blur, separator and removal behavior", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `chips-${Date.now()}`;
  const id = `${scope}/${name}`;
  await createIntegration(apiClient, scope, name);
  const initial = await apiClient.get(`/packages/integrations/${id}`);
  const initialBody = await initial.json();
  const authored = await apiClient.patch(
    `/packages/integrations/${id}`,
    {
      manifest: { ...initialBody.manifest, author: "E2E" },
    },
    { "If-Match": initial.headers()["etag"]! },
  );
  expect(authored.status(), await authored.text()).toBe(200);
  await page.goto(`/integrations/${id}?integrationSettings=identity#configuration`);
  const keywords = page.getByPlaceholder("Ajouter un mot-clé (Entrée ou virgule)");
  const group = keywords.locator("..");
  await keywords.fill("  alpha  ");
  await keywords.press("Enter");
  await expect(keywords).toHaveValue("");
  await keywords.fill("alpha");
  await keywords.press(",");
  await expect(group.getByRole("button", { name: "×", exact: true })).toHaveCount(1);
  await keywords.fill("beta");
  await keywords.press(",");
  await group.getByRole("button", { name: "×", exact: true }).first().click();
  await expect(group).toContainText("beta");
  await expect(group).not.toContainText("alpha");
  await keywords.fill("pending");
  await page.locator("#meta-displayName").click();
  await expect(keywords).toHaveValue("pending");
  await expect(group.getByRole("button", { name: "×", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  const detail = await apiClient.get(`/packages/integrations/${id}`);
  expect((await detail.json()).manifest.keywords).toEqual(["beta"]);

  await page.goto(`/integrations/${id}?integrationSettings=auth-methods#configuration`);
  const uris = page.getByPlaceholder("https://api.example.com/**");
  const uriGroup = uris.locator("..");
  await uris.fill("  https://second.example/**  ");
  await page.locator("#auth-key-0").click();
  await expect(uris).toHaveValue("");
  await expect(uriGroup).toContainText("https://second.example/**");
  await uris.fill("https://second.example/**");
  await uris.press("Enter");
  await expect(uriGroup.getByRole("button", { name: "×", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(uriGroup).toContainText("https://second.example/**");
  const saved = await apiClient.get(`/packages/integrations/${id}`);
  expect((await saved.json()).manifest.auths.api.authorized_uris).toEqual([
    "https://example.invalid/**",
    "https://second.example/**",
  ]);
});

test("a role missing from the assignable catalog stays visible and disabled after loading", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const space = browserCtx.org.defaultSpaceId;
  expect(
    (await orgOnlyClient.patch(`/spaces/${space}`, { default_role: "operator" })).status(),
  ).toBe(200);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/spaces/${space}/roles`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    requested.resolve();
    await release.promise;
    await route.fulfill({
      response,
      json: { ...body, data: body.data.filter((role: { key: string }) => role.key !== "operator") },
    });
  });
  await page.goto("/workspace-settings/general");
  await requested.promise;
  await expect(page.getByRole("textbox", { name: "Nom", exact: true })).toBeVisible();
  const role = page.locator("#space-default-role");
  await expect(role).toHaveCount(0);
  release.resolve();
  await expect(role).toHaveText("Opérateur");
  await role.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "Opérateur", exact: true })).toBeDisabled();
  await page.getByRole("option", { name: "Lecteur", exact: true }).click();
  await expect(role).toHaveText("Lecteur");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect
    .poll(async () => (await (await orgOnlyClient.get(`/spaces/${space}`)).json()).default_role)
    .toBe("viewer");
});

test("advanced schema values commit on blur and survive collapse, apply, save and reload", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `advanced-${Date.now()}`;
  await createAgentWithInputSchema(apiClient, scope, name, {
    amount: { type: "number", minimum: 2 },
  });
  await page.goto(`/agents/${scope}/${name}?agentSettings=schema#settings`);
  const edit = async () => {
    await page.getByRole("button", { name: "Actions pour amount", exact: true }).click();
    await page.getByRole("menuitem", { name: "Modifier", exact: true }).click();
  };
  await edit();
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("button", { name: "Options avancées", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  const minimum = dialog.getByRole("textbox", { name: "Minimum", exact: true });
  await expect(minimum).toHaveValue("2");
  await minimum.fill("7");
  await toggle.click();
  await expect(minimum).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(minimum).toHaveValue("7");
  await dialog.getByRole("button", { name: "Appliquer", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await page.reload();
  await edit();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(minimum).toHaveValue("7");
  const detail = await apiClient.get(`/packages/agents/${scope}/${name}`);
  expect((await detail.json()).manifest.input.schema.properties.amount).toEqual({
    type: "number",
    minimum: 7,
  });
});

test("integration scope picks survive keyboard collapse and are saved on the agent", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const integration = `${scope}/scopes-${Date.now()}`;
  const manifest = apiIntegrationManifest({
    name: integration,
    apiCall: { authKey: "oauth" },
    auths: {
      oauth: {
        type: "oauth2",
        authorizationEndpoint: "https://oauth.example/authorize",
        tokenEndpoint: "https://oauth.example/token",
        defaultScopes: ["base"],
        scopeCatalog: [
          { value: "base", label: "Base" },
          { value: "extra", label: "Extra" },
        ],
      },
    },
  });
  const created = await apiClient.post("/packages/integrations", { manifest });
  expect(created.status(), await created.text()).toBe(201);
  const name = `scope-agent-${Date.now()}`;
  const agent = await apiClient.post("/packages/agents", {
    manifest: {
      schema_version: "0.1",
      name: `${scope}/${name}`,
      display_name: "Scope agent",
      description: "Test scopes",
      type: "agent",
      version: "1.0.0",
      dependencies: { integrations: { [integration]: "^1.0.0" } },
    },
    content: "Test scopes",
  });
  expect(agent.status(), await agent.text()).toBe(201);
  await page.goto(`/agents/${scope}/${name}?agentSettings=integrations#settings`);
  await page.getByRole("button", { name: `Actions pour ${integration}`, exact: true }).click();
  await page.getByRole("menuitem", { name: /outils/i }).click();
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByTestId(`integ-advanced-toggle-${integration}`);
  await toggle.focus();
  await page.keyboard.press("Enter");
  const extra = dialog.getByTestId(`integ-scope-${integration}-extra`).getByRole("checkbox");
  await extra.check();
  await toggle.click();
  await expect(extra).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(extra).toBeChecked();
  await dialog.getByRole("button", { name: "Appliquer", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  const detail = await apiClient.get(`/packages/agents/${scope}/${name}`);
  expect((await detail.json()).manifest.integrations_configuration[integration].scopes).toEqual([
    "extra",
  ]);
});

test("the overlay band follows its viewport scroll across navigation, reopening and mobile widths", async ({
  authedPage: page,
}, testInfo) => {
  for (const width of [1440, 768, 390]) {
    if (width === 390) {
      await page.evaluate(() => localStorage.setItem("appstrate-theme", "dark"));
    }
    await page.setViewportSize({ width, height: 480 });
    await page.goto("/org-settings/general");
    const dialog = page.getByRole("dialog");
    const viewport = dialog.locator("[data-radix-scroll-area-viewport]");
    const band = viewport.locator(".sticky");
    await expect(page.getByRole("textbox", { name: "Nom", exact: true })).toBeVisible();
    await expect(viewport).toBeVisible();
    await expect(band).not.toHaveClass(/border-b/);
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(80);
    await viewport.evaluate((node) => {
      node.scrollTop = 80;
    });
    await expect(band).toHaveClass(/border-b/);
    await viewport.evaluate((node) => {
      node.scrollTop = 4;
    });
    await expect(band).not.toHaveClass(/border-b/);
    await viewport.evaluate((node) => {
      node.scrollTop = 80;
    });
    await expect(band).toHaveClass(/border-b/);
    await page.goto("/preferences/general");
    await expect(band).toBeVisible();
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(band).not.toHaveClass(/border-b/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.goto("/org-settings/general");
    await expect(band).not.toHaveClass(/border-b/);
    await page.screenshot({ path: testInfo.outputPath(`panel-${width}.png`) });
  }
});
