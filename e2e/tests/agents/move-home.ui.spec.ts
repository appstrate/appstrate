// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSchedule, createSpace } from "../../helpers/seed.ts";

test("moving an agent explains schedule deactivation while the count is pending", async ({
  authedPage: page,
  orgOnlyClient,
  apiClient,
  browserCtx,
}) => {
  const { orgId, orgSlug } = browserCtx.org;
  const scope = "@" + orgSlug;
  const name = "hello-world";
  const pkg = scope + "/" + name;
  await createSpace(orgOnlyClient, "Move Destination");
  const schedule = await createSchedule(apiClient, scope, name);
  const before = await apiClient.get("/schedules/" + schedule.id);
  expect((await before.json()).enabled).toBe(true);
  const gate = Promise.withResolvers<void>();
  let held = false;
  await page.route(
    (url) =>
      url.pathname === "/api/orgs/" + orgId + "/schedules" &&
      url.searchParams.get("packageId") === pkg,
    async (route) => {
      held = true;
      await gate.promise;
      await route.continue();
    },
  );
  try {
    await page.goto("/agents/" + pkg);
    await page.getByRole("button", { name: "Actions", exact: true }).first().click();
    await page.getByRole("menuitem", { name: /Déplacer vers un espace|Move to a space/ }).click();
    const modal = page.getByRole("dialog", { name: /Déplacer le package|Move package/ });
    await expect(modal).toBeVisible();
    await expect.poll(() => held).toBe(true);
    await modal.getByRole("combobox").click();
    await page.getByRole("option", { name: "Move Destination" }).click();
    await modal.locator("#move-home-keep").click();
    const submit = modal.getByRole("button", { name: /^(Déplacer|Move)$/ });
    await expect(submit).toBeEnabled();
    const copy = await modal.innerText();
    expect(copy).toMatch(
      /planifications actives.+seront désactivées|active schedules.+will be disabled/i,
    );
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/home"),
    );
    await submit.click();
    const res = await saved;
    expect(res.status(), await res.text()).toBe(200);
    const after = await apiClient.get("/schedules/" + schedule.id);
    const stored = await after.json();
    expect(stored).toMatchObject({ enabled: false, disabled_reason: "package_removed" });
  } finally {
    gate.resolve();
  }
});
