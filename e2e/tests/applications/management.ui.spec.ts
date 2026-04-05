// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E tests for application management.
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, createApplication } from "../../helpers/seed.ts";
import { ApplicationsPage } from "../../pages/applications-page.ts";
import { AgentsPage } from "../../pages/agents-page.ts";

test.describe("Application management in UI", () => {
  test("Applications page lists default app with badge @smoke", async ({ authedPage: page }) => {
    const apps = new ApplicationsPage(page);
    await apps.goto();
    await apps.waitForLoaded();
    await apps.expectDefaultBadgeVisible();
  });

  test("Create application via UI", async ({ authedPage: page }) => {
    const apps = new ApplicationsPage(page);
    await apps.goto();
    await apps.waitForLoaded();

    const appName = `UI App ${Date.now()}`;
    await apps.createApplication(appName);
    await apps.expectAppVisible(appName);
  });

  test("New custom app has empty agent list", async ({
    browser,
    apiClient,
    browserCtx,
    orgOnlyClient,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `ui-empty-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `Empty App ${Date.now()}`);

    const context = await createAuthedContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      customApp.id,
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

  test("Cannot delete default app via API @critical", async ({ orgOnlyClient, browserCtx }) => {
    const res = await orgOnlyClient.delete(`/applications/${browserCtx.org.defaultAppId}`);
    expect([400, 403]).toContain(res.status());
  });
});
