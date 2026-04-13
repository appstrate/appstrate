// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E tests for agent visibility across apps.
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, createApplication, installPackageInApp } from "../../helpers/seed.ts";
import { AgentsPage } from "../../pages/agents-page.ts";
import { Sidebar } from "../../pages/sidebar.ts";
import { WebhooksPage } from "../../pages/webhooks-page.ts";

test.describe("Agent visibility in UI", () => {
  test("Default app shows auto-installed agents on /agents page", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `ui-agent-all-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const agents = new AgentsPage(page);
    await agents.goto();
    await agents.expectAgentVisible(agentName);
  });

  test("Custom app shows only installed agents", async ({
    browser,
    apiClient,
    browserCtx,
    orgOnlyClient,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const installedAgent = `ui-installed-${Date.now()}`;
    const hiddenAgent = `ui-hidden-${Date.now()}`;
    await createAgent(apiClient, scope, installedAgent);
    await createAgent(apiClient, scope, hiddenAgent);

    const customApp = await createApplication(orgOnlyClient, `UI Custom ${Date.now()}`);
    await installPackageInApp(orgOnlyClient, customApp.id, `${scope}/${installedAgent}`);

    const context = await createAuthedContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      customApp.id,
    );
    const customPage = await context.newPage();
    const agents = new AgentsPage(customPage);
    await agents.goto();
    await agents.expectAgentVisible(installedAgent);
    await agents.expectAgentNotVisible(hiddenAgent);
    await context.close();
  });

  test("Switching app via sidebar updates agent list @smoke", async ({
    authedPage: page,
    apiClient,
    browserCtx,
    orgOnlyClient,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `ui-switch-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    const customApp = await createApplication(orgOnlyClient, `SwitchApp ${Date.now()}`);

    const agents = new AgentsPage(page);
    await agents.goto();
    await agents.expectAgentVisible(agentName);

    const sidebar = new Sidebar(page);
    await sidebar.switchApp(customApp.name);

    await agents.expectAgentNotVisible(agentName);
  });

  test("Schedules page loads for current app context", async ({ authedPage: page }) => {
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Webhooks page shows current app webhooks", async ({ authedPage: page, apiClient }) => {
    const webhookUrl = `https://ui-test-${Date.now()}.example.com/hook`;
    await apiClient.post("/webhooks", {
      level: "org",
      url: webhookUrl,
      events: ["run.success"],
    });

    const webhooks = new WebhooksPage(page);
    await webhooks.goto();
    await webhooks.expectWebhookVisible(webhookUrl);
  });
});
