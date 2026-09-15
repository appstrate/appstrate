// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgentWithInputSchema } from "../../helpers/seed.ts";

for (const scenario of [
  { role: "runner", version: "1.2.3", inline: false },
  { role: "runner", version: "draft", inline: false },
  { role: "editor", version: "1.2.3", inline: false },
  { role: "editor", version: "draft", inline: true },
]) {
  test(`rerun: ${scenario.role}, ${scenario.version}, inline=${scenario.inline}`, async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = "rerun-input";
    await createAgentWithInputSchema(apiClient, scope, name, {
      topic: { type: "string", title: "Topic", default: "weekly" },
    });
    const packageId = scenario.inline ? "@inline/incident" : `${scope}/${name}`;
    const runId = "run_incident_42";
    if (scenario.role === "runner") {
      await page.addInitScript(
        (persona) => {
          localStorage.setItem("appstrate_view_as", JSON.stringify(persona));
        },
        {
          orgId: browserCtx.org.orgId,
          orgRole: "member",
          space: {
            spaceId: browserCtx.org.defaultSpaceId,
            role: "preset:runner",
            roleLabel: "Runner",
            spaceName: "Default",
          },
        },
      );
    }
    // Only the historical run and execution response are fixtures; auth, permissions,
    // agent schema, typed client and modal interactions use the application.
    await page.route(
      (url) => url.pathname === `/api/runs/${runId}`,
      (route) =>
        route.fulfill({
          json: {
            id: runId,
            packageId,
            agent_name: "Incident replay",
            status: "success",
            runNumber: 42,
            started_at: "2026-09-11T10:00:00Z",
            duration: 1000,
            input: scenario.role === "runner" ? null : { topic: "incident-42" },
            version_ref: scenario.version,
            file_counts: { input: 0, output: 0 },
            package_ephemeral: scenario.inline,
            cost: null,
            token_usage: null,
            result: null,
            inline_manifest: null,
            inline_prompt: null,
          },
        }),
    );
    await page.route(`**/api/runs/${runId}/logs*`, (route) =>
      route.fulfill({ json: { object: "list", data: [], hasMore: false } }),
    );
    const launchPath = `/api/agents/${scope}/${name}/run`;
    await page.route(
      (url) => url.pathname === launchPath,
      (route) => route.fulfill({ status: 201, json: { id: runId } }),
    );
    await page.goto(`/agents/${packageId}/runs/${runId}`);
    const rerun = page.getByRole("button", { name: "Relancer", exact: true });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCount(0);
    if (scenario.inline) {
      await expect(page.getByRole("heading", { name: "Incident replay" }).first()).toBeVisible();
      await expect(rerun).toHaveCount(0);
      return;
    }
    await expect(rerun).toBeVisible();
    const request = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === launchPath,
    );
    await rerun.click();
    if (scenario.role === "editor") {
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("advanced-input-toggle").click();
      const topic = dialog.getByRole("textbox", { name: "Topic" });
      await expect(topic).toHaveValue("incident-42");
      await topic.fill("reviewed-input");
      await dialog.getByRole("button", { name: /^(Lancer|Run)$/ }).click();
    } else {
      await expect(dialog).toHaveCount(0);
    }
    const sent = await request;
    expect(new URL(sent.url()).searchParams.get("version")).toBe(scenario.version);
    expect(sent.postDataJSON()).toEqual(
      scenario.role === "runner" ? { rerun_from: runId } : { input: { topic: "reviewed-input" } },
    );
  });
}
