// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { seedModel } from "../../helpers/overview.ts";

test("a refused launch picks up an external activation when its tab regains visibility", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const integration = `${scope}/calendar`;
  const agent = `${scope}/report`;
  const placements = `/spaces/${browserCtx.org.defaultSpaceId}/packages`;
  await seedModel(apiClient);
  const created = await apiClient.post("/packages/integrations", {
    publish: true,
    manifest: {
      schema_version: "0.1",
      type: "integration",
      name: integration,
      version: "1.0.0",
      display_name: "Calendar",
      source: {
        kind: "remote",
        remote: { url: "https://calendar.example.com/mcp", transport: "streamable-http" },
      },
      tools_policy: { search: {} },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const report = await apiClient.post("/packages/agents", {
    manifest: {
      schema_version: "0.1",
      type: "agent",
      name: agent,
      version: "1.0.0",
      display_name: "Calendar report",
      dependencies: { integrations: { [integration]: "1.0.0" } },
      integrations_configuration: { [integration]: { required: true, tools: ["search"] } },
    },
    content: "Report on the calendar.",
  });
  expect(report.status(), await report.text()).toBe(201);
  expect((await apiClient.post(placements, { packageId: integration })).ok()).toBe(true);
  expect((await apiClient.delete(`${placements}/${integration}`)).ok()).toBe(true);

  await page.goto(`/agents/${agent}`);
  const refused = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/run"),
  );
  await page.getByRole("button", { name: "Lancer", exact: true }).first().click();
  expect((await refused).status()).toBe(409);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId(`integration-activate-${integration}`)).toBeEnabled();

  // Another session fixes the placement while the launcher keeps the refusal open.
  // Deliver the visibility event explicitly: headless Chromium keeps background pages visible.
  const enabled = await apiClient.post(placements, { packageId: integration });
  expect(enabled.status(), await enabled.text()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog.getByText("Intégration prête", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("missing-connections-retry")).toBeEnabled();
  await expect(dialog.getByRole("button", { name: /connecter/i })).toHaveCount(0);
});
