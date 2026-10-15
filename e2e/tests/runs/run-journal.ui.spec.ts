// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call of the run journal opens in place on its arguments and result.
 *
 * The run and its log rows are fixtures (an inline run has no agent to seed);
 * the page, the virtualized list and the expansion are the application's own.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("journal: a tool call expands in place on its arguments and result", async ({
  authedPage: page,
}) => {
  const runId = "run_journal_1";
  await page.route(
    (url) => url.pathname === `/api/runs/${runId}`,
    (route) =>
      route.fulfill({
        json: {
          id: runId,
          packageId: "@inline/journal",
          agent_name: "Journal",
          status: "success",
          runNumber: 1,
          started_at: "2026-09-11T10:00:00Z",
          duration: 1000,
          input: null,
          version_ref: "draft",
          file_counts: { input: 0, output: 0 },
          package_ephemeral: true,
          cost: null,
          token_usage: null,
          result: null,
          inline_manifest: null,
          inline_prompt: "journal",
        },
      }),
  );
  const row = (id: number, message: string, data: Record<string, unknown>) => ({
    id,
    type: "progress",
    level: "debug",
    event: null,
    message,
    data,
    createdAt: "2026-09-11T10:00:00Z",
  });
  await page.route(`**/api/runs/${runId}/logs*`, (route) =>
    route.fulfill({
      json: {
        object: "list",
        hasMore: false,
        data: [
          row(1, "Tool: bash", { tool: "bash", toolCallId: "c1", args: { command: "echo hi" } }),
          row(2, "Tool result", {
            tool: "bash",
            toolCallId: "c1",
            isError: false,
            result: { stdout: "hi" },
            durationMs: 12,
          }),
        ],
      },
    }),
  );

  await page.goto(`/agents/@inline/journal/runs/${runId}#journal`);
  const call = page.getByRole("button", { name: /bash/ });
  await expect(call).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("echo hi", { exact: false })).toHaveCount(1);

  await call.click();
  await expect(call).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "Arguments" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Résultat" })).toBeVisible();
  await expect(page.getByText('"stdout": "hi"')).toBeVisible();

  await call.click();
  await expect(page.getByRole("heading", { name: "Arguments" })).toHaveCount(0);
});
