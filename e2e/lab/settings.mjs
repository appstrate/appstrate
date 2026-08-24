// SPDX-License-Identifier: Apache-2.0

/**
 * Behaviour guard for the routed settings shell.
 *
 * Screenshots protect rendering and fixtures. This smaller pass protects the
 * router and context contracts that pixels cannot see: dependent selectors,
 * keyed remounts, Back/Close fidelity, legacy URLs and the mobile scope split.
 *
 * Environment:
 *   LAB_URL  base URL of the lab (default http://localhost:5173)
 */

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const BASE = process.env.LAB_URL ?? "http://localhost:5173";
const browser = await chromium.launch({ channel: "chrome" });

async function withPage(run, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

const settle = (page) => page.waitForTimeout(500);

await withPage(async (page) => {
  await page.goto(`${BASE}/workspace-settings/general`);
  await settle(page);

  await page.locator('[data-settings-scope="organization"] button[role="combobox"]').click();
  await page.getByRole("option", { name: "Appstrate" }).click();
  await settle(page);

  assert.equal(new URL(page.url()).pathname, "/workspace-settings/general");
  assert.equal(
    (
      await page.locator('[data-settings-scope="workspace"] button[role="combobox"]').textContent()
    )?.trim(),
    "Default",
  );
  assert.equal(
    await page.locator("[data-settings-content-key]").getAttribute("data-settings-content-key"),
    "workspace:org_lab_2:app_lab_2_default",
  );

  await page.locator('[data-settings-scope="organization"] button[role="combobox"]').click();
  await page.getByRole("option", { name: "Tractr" }).click();
  await settle(page);

  const before = await page
    .locator("[data-settings-content-key]")
    .getAttribute("data-settings-content-key");
  await page.locator('[data-settings-scope="workspace"] button[role="combobox"]').click();
  await page.getByRole("option", { name: "Bac à sable" }).click();
  await settle(page);
  const after = await page
    .locator("[data-settings-content-key]")
    .getAttribute("data-settings-content-key");

  assert.equal(new URL(page.url()).pathname, "/workspace-settings/general");
  assert.notEqual(after, before);
  assert.match(after ?? "", /^workspace:org_lab:/);
});
console.log("  organization/workspace dependency and keyed remount: ok");

await withPage(async (page) => {
  const background = "/runs?status=failed#today";
  await page.goto(`${BASE}${background}`);
  await settle(page);

  await page.locator("button").filter({ hasText: "Tractr" }).first().click();
  await page.getByRole("link", { name: "Paramètres de Tractr" }).first().click();
  await settle(page);
  assert.equal(new URL(page.url()).pathname, "/org-settings/general");

  await page
    .locator('[data-settings-scope="workspace"] a[href="/workspace-settings/general"]')
    .click();
  assert.equal(new URL(page.url()).pathname, "/workspace-settings/general");
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, "/org-settings/general");
  await page.goBack();
  assert.equal(page.url(), `${BASE}${background}`);

  await page.locator("button").filter({ hasText: "Tractr" }).first().click();
  await page.getByRole("link", { name: "Paramètres de Tractr" }).first().click();
  await page.getByRole("button", { name: "Close" }).click();
  assert.equal(page.url(), `${BASE}${background}`);
});
console.log("  Back and complete Close background restoration: ok");

await withPage(async (page) => {
  await page.goto(`${BASE}/org-settings/app/general`);
  await settle(page);
  assert.equal(new URL(page.url()).pathname, "/workspace-settings/general");

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${BASE}/org-settings/general`);
  await settle(page);

  const mobileSections = page.locator("[data-settings-mobile-scope]");
  await mobileSections.first().waitFor({ state: "visible" });
  assert.equal(await mobileSections.count(), 2);
  for (const scope of ["organization", "workspace"]) {
    const section = page.locator(`[data-settings-mobile-scope="${scope}"]`);
    assert.equal(await section.isVisible(), true);
    assert.equal(await section.locator('button[role="combobox"]').count(), 2);
  }
});
console.log("  legacy route and two-scope mobile navigation: ok");

await browser.close();
console.log("\nSettings behaviour guard passed.");
