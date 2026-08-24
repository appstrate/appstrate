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
const assertClose = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.1, `Expected ${actual} to be close to ${expected}`);

const waitForDialogToSettle = (page) =>
  page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog && getComputedStyle(dialog).transform === "none";
  });

async function assertDesktopNavigationState(page, expectedHref) {
  await waitForDialogToSettle(page);
  const current = page.locator('[data-settings-scope] a[aria-current="page"]');
  await page
    .locator(`[data-settings-scope] a[aria-current="page"][href="${expectedHref}"]`)
    .waitFor({ state: "visible" });
  // Leave the rail before counting persistent surfaces. An inactive link under
  // the pointer legitimately paints its transient hover surface.
  await page.mouse.move(800, 50);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-settings-scope] a")].filter(
        (node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)",
      ).length === 1,
  );
  assert.equal(await current.count(), 1);
  assert.equal(await current.getAttribute("href"), expectedHref);

  const linkBackgrounds = await page
    .locator("[data-settings-scope] a")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
  const activeBackground = await current.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(activeBackground, "rgba(0, 0, 0, 0)");
  assert.equal(linkBackgrounds.filter((background) => background !== "rgba(0, 0, 0, 0)").length, 1);

  const sections = page.locator("[data-settings-scope]");
  assert.equal(await sections.count(), 2);
  const sectionStyles = await sections.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        borderLeftColor: style.borderLeftColor,
        borderLeftWidth: style.borderLeftWidth,
      };
    }),
  );
  assert.equal(sectionStyles[0].backgroundColor, sectionStyles[1].backgroundColor);
  assert.equal(sectionStyles[0].borderLeftWidth, "0px");
  assert.equal(sectionStyles[1].borderLeftWidth, "0px");

  for (const scope of ["organization", "workspace"]) {
    const section = page.locator(`[data-settings-scope="${scope}"]`);
    assert.equal(await section.locator("[data-settings-scope-title] svg").count(), 0);
    const selector = section.locator("[data-settings-context-selector]");
    assertClose(await selector.evaluate((node) => node.getBoundingClientRect().height), 36);
    assert.equal(
      await selector.evaluate((node) => getComputedStyle(node).backgroundColor),
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ),
    );
  }
}

await withPage(async (page) => {
  await page.goto(`${BASE}/org-settings/general`);
  await settle(page);
  await assertDesktopNavigationState(page, "/org-settings/general");

  await page
    .locator('[data-settings-scope="organization"] a[href="/org-settings/members"]')
    .click();
  await page.waitForURL("**/org-settings/members");
  await assertDesktopNavigationState(page, "/org-settings/members");

  await page
    .locator('[data-settings-scope="workspace"] a[href="/workspace-settings/api-keys"]')
    .click();
  await page.waitForURL("**/workspace-settings/api-keys");
  await assertDesktopNavigationState(page, "/workspace-settings/api-keys");
});
console.log("  one neutral desktop navigation state across both scopes: ok");

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
  await waitForDialogToSettle(page);

  const mobileSections = page.locator("[data-settings-mobile-scope]");
  await mobileSections.first().waitFor({ state: "visible" });
  assert.equal(await mobileSections.count(), 2);
  const mobileSectionStyles = await mobileSections.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
      };
    }),
  );
  assert.deepEqual(mobileSectionStyles[0], mobileSectionStyles[1]);
  for (const scope of ["organization", "workspace"]) {
    const section = page.locator(`[data-settings-mobile-scope="${scope}"]`);
    assert.equal(await section.isVisible(), true);
    assert.equal(await section.locator('button[role="combobox"]').count(), 2);
    assert.equal(await section.locator("[data-settings-scope-title] svg").count(), 0);

    const contextSelector = section.locator("[data-settings-context-selector]");
    assertClose(await contextSelector.evaluate((node) => node.getBoundingClientRect().height), 44);
    assertClose(
      await contextSelector.evaluate((node) => {
        const style = getComputedStyle(node, "::before");
        return (
          Number.parseFloat(style.height) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth)
        );
      }),
      40,
    );
    assertClose(
      await section
        .locator("[data-settings-page-selector]")
        .evaluate((node) => node.getBoundingClientRect().height),
      40,
    );
  }

  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
});
console.log("  legacy route and two neutral mobile scope groups: ok");

await browser.close();
console.log("\nSettings behaviour guard passed.");
