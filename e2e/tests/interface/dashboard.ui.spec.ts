// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

for (const available of [true, false]) {
  test(`dashboard keeps its content when the active count is ${available ? "available" : "unavailable"}`, async ({
    authedPage: page,
  }) => {
    // The activity feed is empty. The independent, filtered count may include older runs.
    const filteredCount = (url: URL) =>
      url.pathname.endsWith("/runs") && url.searchParams.get("status") === "running";
    await page.route(filteredCount, (route) =>
      route.fulfill(
        available
          ? { json: { object: "list", data: [], total: 26, hasMore: false } }
          : { status: 403, json: { error: { code: "forbidden", message: "Count unavailable" } } },
      ),
    );
    const counted = page.waitForResponse((response) => filteredCount(new URL(response.url())));
    await page.goto("/");
    await counted;
    await expect(page.getByText("Rien à afficher ici")).toBeVisible();
    if (available) await expect(page.getByText(/26 runs en cours/)).toBeVisible();
    else await expect(page.getByText(/\d+ runs? en cours/)).toHaveCount(0);
  });
}
