// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E tests for space management.
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, createSpace } from "../../helpers/seed.ts";
import { SpacesPage } from "../../pages/spaces-page.ts";
import { AgentsPage } from "../../pages/agents-page.ts";
import { Sidebar } from "../../pages/sidebar.ts";

test.describe("Space management in UI", () => {
  test("Spaces page lists default space with badge @smoke", async ({ authedPage: page }) => {
    const spaces = new SpacesPage(page);
    await spaces.goto();
    await spaces.waitForLoaded();
    await spaces.expectDefaultBadgeVisible();
  });

  test("Create space via UI", async ({ authedPage: page }) => {
    const spaces = new SpacesPage(page);
    await spaces.goto();
    await spaces.waitForLoaded();

    const spaceName = `UI Space ${Date.now()}`;
    await spaces.createSpace(spaceName);
    await spaces.expectSpaceVisible(spaceName);
  });

  test("New custom space has empty agent list", async ({
    browser,
    apiClient,
    browserCtx,
    orgOnlyClient,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `ui-empty-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customSpace = await createSpace(orgOnlyClient, `Empty Space ${Date.now()}`);

    const context = await createAuthedContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      customSpace.id,
    );
    const customPage = await context.newPage();
    const agents = new AgentsPage(customPage);
    await agents.goto();
    await expect(customPage.getByRole("heading", { level: 1 }).first()).toBeVisible({
      timeout: 10_000,
    });
    await agents.expectAgentNotVisible(agentName);
    await context.close();
  });

  test("Default-role picker offers every preset, the runner included", async ({
    authedPage: page,
  }) => {
    // The picker derives its options from `SPACE_ROLE_PRESETS`, so a preset that
    // never reached the label file renders as its raw key.
    await page.goto("/workspace-settings/general");
    await page.locator("#space-default-role").click();
    for (const label of [
      /^(Administrateur de l'espace|Space admin)$/,
      /^(Créateur|Builder)$/,
      /^(Opérateur|Operator)$/,
      /^(Exécutant|Runner)$/,
      /^(Lecteur|Viewer)$/,
    ]) {
      await expect(page.getByRole("option", { name: label })).toBeVisible();
    }
  });

  test("Cannot delete default space via API @critical", async ({ orgOnlyClient, browserCtx }) => {
    const res = await orgOnlyClient.delete(`/spaces/${browserCtx.org.defaultSpaceId}`);
    // 409 exactly — the default-space rule (`default_space_not_deletable`),
    // not RBAC. See the same assertion in tests/spaces/cascade-deletion.api.spec.ts.
    expect(res.status()).toBe(409);
  });

  test("Switching cached spaces keeps each space's own settings, saved as they are picked", async ({
    authedPage: page,
    orgOnlyClient,
  }) => {
    const source = await createSpace(orgOnlyClient, `Draft source ${Date.now()}`);
    const target = await createSpace(orgOnlyClient, `Draft target ${Date.now()}`);
    const configured = await orgOnlyClient.patch(`/spaces/${target.id}`, {
      visibility: "open",
      default_role: "viewer",
    });
    expect(configured.status()).toBe(200);

    await page.goto("/workspace-settings/general");
    const sidebar = new Sidebar(page);
    const name = page.getByRole("textbox", { name: "Nom", exact: true });
    // Prime B's detail cache, then change A. Every setting commits at once (no
    // draft, no save button), so the return to B must show B's own values and
    // A's pick must have reached A only.
    await sidebar.switchSpaceInSettings(target.name);
    await expect(name).toHaveValue(target.name);
    await sidebar.switchSpaceInSettings(source.name);
    await expect(name).toHaveValue(source.name);

    const sourceSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/spaces/${source.id}`),
    );
    await page.locator("#space-default-role").click();
    await page.getByRole("option", { name: /^(Administrateur de l'espace|Space admin)$/ }).click();
    expect((await sourceSaved).status()).toBe(200);

    await sidebar.switchSpaceInSettings(target.name);
    await expect(name).toHaveValue(target.name);
    await expect(page.locator("#space-visibility-open")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#space-default-role")).toContainText(/Lecteur|Viewer/);

    const renamed = `${target.name} renamed`;
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/spaces/${target.id}`),
    );
    await name.fill(renamed);
    await name.press("Enter");
    expect((await saved).status()).toBe(200);
    const persisted = await orgOnlyClient.get(`/spaces/${target.id}`);
    expect(await persisted.json()).toMatchObject({
      name: renamed,
      visibility: "open",
      default_role: "viewer",
    });
    const changed = await orgOnlyClient.get(`/spaces/${source.id}`);
    expect(await changed.json()).toMatchObject({
      visibility: "open",
      default_role: "admin",
    });
  });
});
