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
});
