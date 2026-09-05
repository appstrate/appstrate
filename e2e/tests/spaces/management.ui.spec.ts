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
    await expect(customPage.getByRole("heading", { level: 2 }).first()).toBeVisible({
      timeout: 10_000,
    });
    await agents.expectAgentNotVisible(agentName);
    await context.close();
  });

  test("Cannot delete default space via API @critical", async ({ orgOnlyClient, browserCtx }) => {
    const res = await orgOnlyClient.delete(`/spaces/${browserCtx.org.defaultSpaceId}`);
    // 400 exactly — the default-space rule (`invalidRequest`), not RBAC. See
    // the same assertion in tests/spaces/cascade-deletion.api.spec.ts.
    expect(res.status()).toBe(400);
  });

  test("Switching cached spaces resets unsaved visibility and default-role edits", async ({
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

    await page.goto("/org-settings/space/general");
    const sidebar = new Sidebar(page);
    const switchSpace = async (spaceId: string) => {
      await sidebar.openSwitcher();
      await sidebar.spaceSubmenuTrigger.click();
      await page.getByTestId(`space-item-${spaceId}`).click();
      await expect(sidebar.dropdownMenu).toHaveCount(0);
    };
    const name = page.locator("#space-name");
    // Prime B's detail cache, then edit A. On the return to B there is no
    // loading-state unmount to accidentally clear A's draft for us.
    await switchSpace(target.id);
    await expect(name).toHaveValue(target.name);
    await switchSpace(source.id);
    await expect(name).toHaveValue(source.name);

    await page.locator("#space-default-role").click();
    await page.getByRole("option", { name: /^(Administrateur|Admin)$/ }).click();
    await page.locator("#space-visibility-private").click();

    await switchSpace(target.id);
    await expect(name).toHaveValue(target.name);
    await expect(page.locator("#space-visibility-open")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#space-default-role")).toContainText(/Lecteur|Viewer/);

    const renamed = `${target.name} renamed`;
    await name.fill(renamed);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/spaces/${target.id}`),
    );
    await page.locator('form button[type="submit"]').click();
    expect((await saved).status()).toBe(200);
    const persisted = await orgOnlyClient.get(`/spaces/${target.id}`);
    expect(await persisted.json()).toMatchObject({
      name: renamed,
      visibility: "open",
      default_role: "viewer",
    });
    const unchanged = await orgOnlyClient.get(`/spaces/${source.id}`);
    expect(await unchanged.json()).toMatchObject({ visibility: "open", default_role: "operator" });
  });
});
