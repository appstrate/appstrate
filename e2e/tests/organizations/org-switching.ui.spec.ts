// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E tests for organization switching.
 * @tags @critical
 */

import { test, expect } from "../../fixtures/multi-org-browser.fixture.ts";
import { createAgent, createWebhook } from "../../helpers/seed.ts";
import { AgentsPage } from "../../pages/agents-page.ts";
import { Sidebar } from "../../pages/sidebar.ts";
import { WebhooksPage } from "../../pages/webhooks-page.ts";

test.describe("Org switching in UI", () => {
  test("Org switcher dropdown shows both orgs @smoke", async ({ authedPage: page, orgA, orgB }) => {
    const agents = new AgentsPage(page);
    await agents.goto();
    await expect(page.getByRole("heading", { name: /agents/i })).toBeVisible({
      timeout: 10_000,
    });

    const sidebar = new Sidebar(page);
    await sidebar.openSwitcher();

    await expect(sidebar.dropdownMenu.getByText(orgA.orgName)).toBeVisible();
    await expect(sidebar.dropdownMenu.getByText(orgB.orgName)).toBeVisible();
  });

  test("Agent list shows only current org agents", async ({
    authedPage: page,
    clientA,
    clientB,
    orgA,
    orgB,
  }) => {
    const scopeA = `@${orgA.orgSlug}`;
    const scopeB = `@${orgB.orgSlug}`;
    const agentA = `org-sw-a-${Date.now()}`;
    const agentB = `org-sw-b-${Date.now()}`;
    await createAgent(clientA, scopeA, agentA);
    await createAgent(clientB, scopeB, agentB);

    const agents = new AgentsPage(page);
    await agents.goto();
    await agents.expectAgentVisible(agentA);
    await agents.expectAgentNotVisible(agentB);
  });

  test("Switching org returns home and shows the other org agents @critical", async ({
    authedPage: page,
    clientA,
    clientB,
    orgA,
    orgB,
  }) => {
    const scopeA = `@${orgA.orgSlug}`;
    const scopeB = `@${orgB.orgSlug}`;
    const agentA = `sw-agent-a-${Date.now()}`;
    const agentB = `sw-agent-b-${Date.now()}`;
    await createAgent(clientA, scopeA, agentA);
    await createAgent(clientB, scopeB, agentB);

    const agents = new AgentsPage(page);
    await agents.goto();
    await agents.expectAgentVisible(agentA);

    const sidebar = new Sidebar(page);
    await sidebar.switchOrg(orgB.orgName);

    // The sidebar entry: the trail may name the same page while it lands.
    await page
      .getByRole("link", { name: "Agents", exact: true })
      .and(page.locator("[data-sidebar=menu-button]"))
      .click();
    await agents.waitForLoaded();
    await agents.expectAgentVisible(agentB);
    await agents.expectAgentNotVisible(agentA);
  });

  test("The gear of another org opens its settings over its landing, not the page left", async ({
    authedPage: page,
    clientA,
    orgA,
    orgB,
  }) => {
    const scopeA = `@${orgA.orgSlug}`;
    const agentA = `gear-agent-a-${Date.now()}`;
    await createAgent(clientA, scopeA, agentA);
    await page.goto(`/agents/${scopeA}/${agentA}`);
    await expect(page.getByText(agentA).first()).toBeVisible({ timeout: 10_000 });

    const sidebar = new Sidebar(page);
    await sidebar.openOrgSettings(orgB.orgName);

    // The current organization is the one whose settings are open…
    await expect
      .poll(() => sidebar.switcherButton.getAttribute("aria-label"))
      .toContain(`actuel : ${orgB.orgName}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    // …and the page beneath is its landing, not organization A's agent (a 404 there).
    await expect(page.getByText(agentA)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL("/dashboard");
  });

  test("Webhook page reflects current org context", async ({ authedPage: page, clientA }) => {
    const webhookUrl = `https://org-sw-wh-${Date.now()}.example.com/hook`;
    await createWebhook(clientA, { url: webhookUrl });

    const webhooks = new WebhooksPage(page);
    await webhooks.goto();
    await webhooks.expectWebhookVisible(webhookUrl);
  });

  test("No stale data after org switch", async ({ authedPage: page, clientA, orgA, orgB }) => {
    const scopeA = `@${orgA.orgSlug}`;
    const uniqueAgent = `stale-check-${Date.now()}`;
    await createAgent(clientA, scopeA, uniqueAgent);

    const agents = new AgentsPage(page);
    await agents.goto();
    await agents.expectAgentVisible(uniqueAgent);

    const sidebar = new Sidebar(page);
    await sidebar.switchOrg(orgB.orgName);

    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await agents.waitForLoaded();
    await agents.expectAgentNotVisible(uniqueAgent);
  });
});
