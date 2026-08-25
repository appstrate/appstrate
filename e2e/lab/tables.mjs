// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering guard for the table grammar.
 *
 * A table inside settings is part of the white settings surface and therefore
 * has no card frame of its own. A table on a level-one collection keeps its
 * white bordered frame. This walks the real routes at the two review widths so
 * a page cannot silently opt out of the shared surface rule.
 *
 * Environment:
 *   LAB_URL  base URL of the lab (default http://localhost:5175)
 */

import { chromium } from "@playwright/test";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const WIDTHS = [1440, 390];

const MAIN_COLLECTIONS = [
  { path: "/agents", pageActions: ["import", "create"] },
  { path: "/skills", pageActions: ["import", "create"] },
  { path: "/mcp-servers", pageActions: ["import"] },
  { path: "/documents", pageActions: [] },
  { path: "/runs", pageActions: ["mark-all-read"] },
  { path: "/schedules", pageActions: ["create"] },
  { path: "/integrations", pageActions: ["catalogue", "create"] },
];

const SETTINGS_TABLES = [
  { path: "/org-settings/members", pageActions: ["invite"] },
  { path: "/org-settings/applications", pageActions: ["create"] },
  { path: "/org-settings/models", pageActions: ["create-model"] },
  { path: "/org-settings/proxies", pageActions: ["create"] },
  { path: "/org-settings/oauth", pageActions: ["create"] },
  { path: "/org-settings/cli-sessions", pageActions: [] },
  { path: "/workspace-settings/end-users", pageActions: ["create"] },
  { path: "/workspace-settings/webhooks", pageActions: ["create"] },
  { path: "/workspace-settings/api-keys", pageActions: ["create"] },
];

const browser = await chromium.launch({ channel: "chrome" });

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function withPage(width, run) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

async function open(page, path, selector = 'table[role="table"]:visible') {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  // The settings shell survives route changes. Let its Outlet replace the old
  // page before resolving a live locator, or the previous table can satisfy the
  // selector and detach between the wait and the geometry read.
  await page.waitForTimeout(300);
  const table = page.locator(selector).first();
  await table.waitFor({ state: "visible" });
  return table;
}

async function frameStyle(table) {
  return table.evaluate((tableElement) => {
    const element = tableElement.parentElement;
    if (!element) throw new Error("table frame is missing");
    const style = getComputedStyle(element);
    const shadowColors = style.boxShadow.match(/rgba?\([^)]*\)/g) ?? [];
    const visibleShadow =
      style.boxShadow !== "none" &&
      shadowColors.some((color) => {
        if (color.startsWith("rgb(")) return true;
        const channels = color.match(/[\d.]+/g) ?? [];
        return Number(channels.at(-1)) > 0;
      });
    return {
      borderTopWidth: style.borderTopWidth,
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      backgroundColor: style.backgroundColor,
      visibleShadow,
      tableOverflow: element.scrollWidth - element.clientWidth,
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

function assertNoOverflow(style, path, width) {
  assertCondition(
    style.tableOverflow <= 1,
    `${path} table overflows by ${style.tableOverflow}px at ${width}`,
  );
  assertCondition(
    style.viewportOverflow <= 1,
    `${path} viewport overflows by ${style.viewportOverflow}px at ${width}`,
  );
}

function assertTableSurface(style, path, width, surface) {
  const integrated = surface === "integrated";
  assertEqual(
    style.borderTopWidth,
    integrated ? "0px" : "1px",
    `${path} ${integrated ? "must be integrated" : "must keep its table frame"} at ${width}`,
  );
  assertCondition(
    integrated ? style.borderRadius === 0 : style.borderRadius > 0,
    `${path} ${integrated ? "must have no table radius" : "must keep its table radius"} at ${width}`,
  );
  assertEqual(
    style.backgroundColor === "rgba(0, 0, 0, 0)",
    integrated,
    `${path} must ${integrated ? "inherit" : "own"} its table surface at ${width}`,
  );
  assertEqual(
    style.visibleShadow,
    !integrated,
    `${path} must ${integrated ? "have no" : "keep its"} table shadow at ${width}`,
  );
  assertNoOverflow(style, path, width);
}

async function assertPageActions(page, path, width, expectedActions) {
  const trigger = page.locator("[data-page-actions]:visible [data-page-actions-trigger]").first();
  assertEqual(
    await page.locator("[data-page-actions]:visible [data-page-actions-trigger]").count(),
    expectedActions.length > 0 ? 1 : 0,
    `${path} must expose one stable Actions trigger when it has page deeds at ${width}`,
  );
  if (expectedActions.length === 0) return;

  await trigger.click();
  const menu = page.locator('[role="menu"]:visible').first();
  await menu.waitFor({ state: "visible" });
  const renderedActions = await menu
    .locator("[data-page-action]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-page-action")));
  assertEqual(
    JSON.stringify(renderedActions),
    JSON.stringify(expectedActions),
    `${path} Actions menu must carry every page deed at ${width}`,
  );
  await page.keyboard.press("Escape");
}

for (const width of WIDTHS) {
  await withPage(width, async (page) => {
    for (const { path, pageActions } of MAIN_COLLECTIONS) {
      const table = await open(page, path);
      const style = await frameStyle(table);
      assertTableSurface(style, path, width, "card");

      const toolbar = page.locator('[data-list-toolbar="page"]:visible').first();
      await toolbar.waitFor({ state: "visible" });
      assertEqual(await toolbar.locator('[aria-pressed="true"]').count(), 1, path);
      assertEqual(await toolbar.locator('[aria-pressed="false"]').count(), 1, path);
      await assertPageActions(page, path, width, pageActions);
      assertEqual(await toolbar.locator("[data-page-actions]").count(), 0, path);
    }
  });

  await withPage(width, async (page) => {
    for (const { path, pageActions } of SETTINGS_TABLES) {
      let table;
      try {
        table = await open(page, path, '[data-settings-content-key] table[role="table"]:visible');
      } catch (error) {
        throw new Error(`${path} did not render its settings table at ${width}`, {
          cause: error,
        });
      }
      const style = await frameStyle(table);
      assertTableSurface(style, path, width, "integrated");
      await assertPageActions(page, path, width, pageActions);
    }
  });

  await withPage(width, async (page) => {
    const modelsPath = "/org-settings/models#credentials";
    await open(page, "/org-settings/models", '[data-settings-content-key] table[role="table"]');
    await page.getByTestId("models-credentials-tab").click();
    const credentialsTable = page
      .locator('[data-settings-content-key] table[role="table"]:visible')
      .first();
    await credentialsTable.waitFor({ state: "visible" });
    assertTableSurface(await frameStyle(credentialsTable), modelsPath, width, "integrated");
    await assertPageActions(page, modelsPath, width, ["create-credential"]);

    const detailPath = "/integrations/@appstrate/google-drive";
    const connectionsTable = await open(page, detailPath, 'main table[role="table"]:visible');
    assertTableSurface(await frameStyle(connectionsTable), detailPath, width, "card");
    await page.getByTestId("tab-configuration").click();
    const clientsTable = page.locator('main table[role="table"]:visible').first();
    await clientsTable.waitFor({ state: "visible" });
    assertTableSurface(
      await frameStyle(clientsTable),
      `${detailPath}#configuration`,
      width,
      "card",
    );

    const cataloguePath = "/integrations?catalogue=1";
    await page.goto(`${BASE}${cataloguePath}`, { waitUntil: "domcontentloaded" });
    const catalogue = page.locator('[role="dialog"]:visible').first();
    await catalogue.waitFor({ state: "visible" });
    if (width < 768) {
      const mobileControls = catalogue.locator('[data-catalogue-controls="mobile"]:visible');
      await mobileControls.waitFor({ state: "visible" });
      assertEqual(
        await mobileControls.locator('[data-list-toolbar="panel"]:visible').count(),
        1,
        `${cataloguePath} must keep its mobile panel toolbar at ${width}`,
      );
    } else {
      assertEqual(
        await catalogue.locator('[data-catalogue-controls="rail"]:visible').count(),
        1,
        `${cataloguePath} must keep its desktop filter rail at ${width}`,
      );
    }

    const endUsersPath = "/workspace-settings/end-users";
    await open(page, endUsersPath, '[data-settings-content-key] table[role="table"]:visible');
    assertEqual(
      await page.locator('[data-settings-content-key] [data-list-toolbar="page"]:visible').count(),
      1,
      `${endUsersPath} must keep its list controls at ${width}`,
    );

    const libraryPath = "/org-settings/library";
    await page.goto(`${BASE}${libraryPath}`, { waitUntil: "domcontentloaded" });
    const matrix = page
      .locator("[data-settings-content-key] [data-library-matrix]:visible")
      .first();
    await matrix.waitFor({ state: "visible" });
    assertEqual(
      await matrix.getAttribute("role"),
      null,
      `${libraryPath} must stay a native matrix`,
    );
    assertEqual(
      await page.locator('[data-settings-content-key] table[role="table"]:visible').count(),
      0,
      `${libraryPath} must not become a collection DataTable`,
    );
    const matrixOverflow = await matrix.locator("..").evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assertCondition(
      ["auto", "scroll"].includes(matrixOverflow.overflowX),
      `${libraryPath} matrix must own horizontal overflow at ${width}`,
    );
    assertCondition(
      matrixOverflow.viewportOverflow <= 1,
      `${libraryPath} viewport overflows by ${matrixOverflow.viewportOverflow}px at ${width}`,
    );
  });
}

await browser.close();
await Bun.write(
  Bun.stdout,
  `Table grammar: ${MAIN_COLLECTIONS.length} main collections, ${SETTINGS_TABLES.length} settings tables and special detail, catalogue, toolbar and matrix surfaces at ${WIDTHS.join("/")}px: ok\n`,
);
