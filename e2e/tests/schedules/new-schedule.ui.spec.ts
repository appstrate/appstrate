// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("shows an unavailable agent catalogue when creating a schedule", async ({
  authedPage: page,
}) => {
  await page.route(/\/api\/(?:orgs\/[^/]+\/)?agents\/?(?:\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      json: { title: "Catalogue indisponible", detail: "Catalogue indisponible", status: 503 },
    }),
  );
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Nouvelle planification", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Catalogue indisponible", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Créer|Enregistrer/ })).toHaveCount(0);
});
