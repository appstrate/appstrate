// SPDX-License-Identifier: Apache-2.0

/** Focused guard for the 25 August settings review corrections. */

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const browser = await chromium.launch({ channel: "chrome" });
const failures = [];

async function withPage(viewport, run) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();
  const fixtureHoles = [];
  page.on("console", (message) => {
    if (message.text().includes("[lab] no fixture")) fixtureHoles.push(message.text());
  });
  try {
    await run(page, fixtureHoles);
  } finally {
    await context.close();
  }
}

async function openSettings(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page
    .locator('[role="dialog"]:visible, [data-settings-mobile-surface]:visible')
    .first()
    .waitFor({ state: "visible" });
}

async function check(name, run) {
  try {
    await run();
    console.log(`  ${name}: ok`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`  ${name}: FAILED`);
  }
}

await check("localized creation titles", () =>
  withPage({ width: 1440, height: 1000 }, async (page) => {
    const cases = [
      ["/agents?create=agent", "Créer un nouvel agent"],
      ["/skills?create=skill", "Créer un nouveau skill"],
      ["/integrations?create=integration", "Créer une nouvelle intégration"],
      ["/mcp-servers?create=mcp-server", "Créer un nouveau serveur MCP"],
    ];
    for (const [path, title] of cases) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    }
  }),
);

await check("preference rows and fixtures", () =>
  withPage({ width: 1440, height: 1000 }, async (page, fixtureHoles) => {
    await openSettings(page, "/preferences/appearance");
    const theme = page.getByRole("combobox").first();
    const borderedWrappers = await theme.evaluate((control) => {
      let count = 0;
      let node = control.parentElement;
      const dialog = control.closest('[role="dialog"]');
      while (node && node !== dialog) {
        const style = getComputedStyle(node);
        if (
          parseFloat(style.borderLeftWidth) > 0 &&
          parseFloat(style.borderRightWidth) > 0 &&
          parseFloat(style.borderRadius) > 0
        ) {
          count += 1;
        }
        node = node.parentElement;
      }
      return count;
    });
    assert.equal(borderedWrappers, 0);

    for (const path of [
      "/preferences/security",
      "/preferences/devices",
      "/preferences/connections",
    ]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("dialog").waitFor({ state: "visible" });
      await page.waitForTimeout(300);
    }
    assert.deepEqual(fixtureHoles, []);
    assert.equal(await page.getByText("Une erreur est survenue.").count(), 0);
  }),
);

await check("library matrix horizontal access", () =>
  withPage({ width: 390, height: 1000 }, async (page) => {
    await openSettings(page, "/org-settings/library");
    const table = page.locator("table[data-library-matrix]");
    const geometry = await table.evaluate((node) => {
      const viewport = node.parentElement;
      if (!viewport) throw new Error("Library table viewport missing");
      viewport.scrollLeft = viewport.scrollWidth;
      return {
        table: node.getBoundingClientRect().width,
        viewport: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        scrollLeft: viewport.scrollLeft,
      };
    });
    assert.ok(geometry.table > geometry.viewport);
    assert.ok(geometry.scrollWidth > geometry.viewport);
    assert.ok(geometry.scrollLeft > 0);
  }),
);

await check("MCP access stays inside the tablet panel", () =>
  withPage({ width: 900, height: 1000 }, async (page) => {
    await openSettings(page, "/org-settings/mcp-access");
    const content = page.locator("[data-settings-content-key]");
    const geometry = await content.evaluate((node) => {
      const dialog = node.closest('[role="dialog"]');
      if (!dialog) throw new Error("Settings dialog missing");
      const contentRect = node.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      return { contentRight: contentRect.right, dialogRight: dialogRect.right };
    });
    assert.ok(geometry.contentRight <= geometry.dialogRight + 1);
  }),
);

await check("end-user edit returns to its origin", () =>
  withPage({ width: 1440, height: 1000 }, async (page) => {
    await openSettings(page, "/workspace-settings/end-users");
    await page.getByRole("button", { name: "Modifier" }).first().click();
    await page.locator("#eu-edit-name").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Annuler" }).click();
    assert.equal(new URL(page.url()).searchParams.has("user"), false);
    await page
      .getByRole("heading", { name: "Marie Lavoie" })
      .waitFor({ state: "hidden" })
      .catch(() => undefined);
    assert.equal(
      await page
        .getByRole("heading", { name: "Marie Lavoie" })
        .isVisible()
        .catch(() => false),
      false,
    );

    await page.locator('[data-data-table-row] a[aria-label="Ouvrir Marie Lavoie"]').click();
    await page.getByRole("heading", { name: "Marie Lavoie" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Modifier" }).click();
    await page.getByRole("button", { name: "Annuler" }).click();
    assert.equal(new URL(page.url()).searchParams.get("user"), "eu_lab_1");
    assert.equal(new URL(page.url()).searchParams.has("edit"), false);
  }),
);

await check("settings table search uses the toolbar surface", () =>
  withPage({ width: 1440, height: 1000 }, async (page) => {
    await openSettings(page, "/workspace-settings/end-users");
    const search = page.getByPlaceholder("Rechercher par nom ou email...");
    const colours = await search.evaluate((node) => {
      const reference = document.createElement("div");
      reference.style.backgroundColor = "var(--background)";
      document.body.append(reference);
      const result = {
        actual: getComputedStyle(node).backgroundColor,
        expected: getComputedStyle(reference).backgroundColor,
      };
      reference.remove();
      return result;
    });
    assert.equal(colours.actual, colours.expected);
  }),
);

await check("API documentation is a page action", () =>
  withPage({ width: 1440, height: 1000 }, async (page) => {
    await openSettings(page, "/workspace-settings/api-keys");
    await page.locator("[data-page-actions-trigger]:visible").click();
    const docs = page.getByRole("menuitem", { name: "Documentation API" });
    await docs.waitFor({ state: "visible" });
    assert.equal(await docs.getAttribute("target"), "_blank");
  }),
);

await browser.close();

if (failures.length > 0) {
  console.error("\nSettings review corrections failed:\n" + failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}

console.log("\nSettings review corrections passed.");
