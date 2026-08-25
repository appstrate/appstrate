// SPDX-License-Identifier: Apache-2.0

/**
 * Responsive information-access guard for settings tables.
 *
 * A responsive tier may hide a comparison column, but it may not make that
 * fact disappear from the product. This records the first nominal row at the
 * reviewed desktop width, then proves that every fact removed at the narrow
 * desktop boundary and phone width can be reopened from the same row.
 */

import { chromium } from "@playwright/test";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const DESKTOP_WIDTH = 1440;
const RESPONSIVE_WIDTHS = [768, 390];

const SETTINGS_TABLES = [
  { path: "/org-settings/members" },
  { path: "/org-settings/applications" },
  { path: "/org-settings/models" },
  { path: "/org-settings/proxies" },
  { path: "/org-settings/oauth" },
  { path: "/org-settings/cli-sessions" },
  { path: "/workspace-settings/end-users" },
  { path: "/workspace-settings/webhooks" },
  { path: "/workspace-settings/api-keys" },
  {
    path: "/org-settings/models#credentials",
    prepare: async (page) => page.getByTestId("models-credentials-tab").click(),
  },
];

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function openTable(page, tableCase) {
  await page.goto(`${BASE}${tableCase.path.split("#")[0]}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(300);
  if (tableCase.prepare) await tableCase.prepare(page);
  const table = page.locator('[data-settings-content-key] table[role="table"]:visible').first();
  await table.waitFor({ state: "visible" });
  return table;
}

async function firstRowFacts(table, path) {
  const headers = table.getByRole("columnheader");
  const row = table.getByRole("row").nth(1);
  const cells = row.getByRole("cell");
  let count = 0;
  let cellCount = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    count = await headers.count();
    cellCount = await cells.count();
    if (count > 0 && count === cellCount) break;
    await table.page().waitForTimeout(100);
  }
  assertCondition(
    count > 0 && count === cellCount,
    `${path} header and cell counts must match, got ${count}/${cellCount}`,
  );

  const facts = [];
  for (let index = 0; index < count; index += 1) {
    const header = headers.nth(index);
    const cell = cells.nth(index);
    const label = (await header.innerText()).trim();
    const value = (await cell.innerText()).replace(/\s+/g, " ").trim();
    const visible = await cell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    });
    if (label && label.toLocaleLowerCase("fr").trim() !== "actions" && value) {
      facts.push({ index, label, value, visible });
    }
  }
  return { facts, row };
}

async function scrollCellIntoView(cell) {
  await cell.evaluate((element) => {
    const viewport = element.closest("[data-radix-scroll-area-viewport]");
    if (!viewport) return;
    const style = getComputedStyle(element);
    const alignsEnd = style.justifyContent === "flex-end" || style.textAlign === "right";
    viewport.scrollLeft = alignsEnd
      ? element.offsetLeft + element.offsetWidth - viewport.clientWidth
      : element.offsetLeft;
  });
}

const browser = await chromium.launch({ channel: "chrome" });
const desktopContext = await browser.newContext({
  viewport: { width: DESKTOP_WIDTH, height: 1000 },
});
await desktopContext.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
const desktopPage = await desktopContext.newPage();
const desktopFacts = new Map();

for (const tableCase of SETTINGS_TABLES) {
  const table = await openTable(desktopPage, tableCase);
  const { facts } = await firstRowFacts(table, tableCase.path);
  const hiddenFacts = facts.filter((fact) => !fact.visible);
  assertCondition(
    hiddenFacts.length === 0,
    `${tableCase.path} hides ${hiddenFacts.map((fact) => fact.label).join(", ")} at ${DESKTOP_WIDTH}px`,
  );
  desktopFacts.set(tableCase.path, facts);
}
await desktopContext.close();

let responsiveFactCount = 0;
for (const width of RESPONSIVE_WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();

  for (const tableCase of SETTINGS_TABLES) {
    const table = await openTable(page, tableCase);
    const { facts: responsiveFacts, row } = await firstRowFacts(table, tableCase.path);
    const responsiveByIndex = new Map(responsiveFacts.map((fact) => [fact.index, fact]));
    const desktopRowFacts = desktopFacts.get(tableCase.path) ?? [];
    const hiddenFacts = desktopRowFacts.filter(
      (fact) => !responsiveByIndex.get(fact.index)?.visible,
    );
    if (hiddenFacts.length > 0) {
      responsiveFactCount += hiddenFacts.length;
      const trigger = row.locator("[data-settings-row-details-trigger]");
      assertCondition(
        (await trigger.count()) === 1,
        `${tableCase.path} hides ${hiddenFacts.map((fact) => fact.label).join(", ")} at ${width}px without one row-details trigger`,
      );
      await trigger.click();
      const details = row.locator("[data-settings-row-details]");
      await details.waitFor({ state: "visible" });
      const detailsText = (await details.innerText()).replace(/\s+/g, " ");
      for (const fact of hiddenFacts) {
        assertCondition(
          detailsText.includes(fact.label) && detailsText.includes(fact.value),
          `${tableCase.path} does not expose ${fact.label}: ${fact.value} at ${width}px`,
        );
      }
    }

    const scrollViewport = table
      .locator("xpath=ancestor::*[@data-data-table-scroll][1]")
      .locator("[data-radix-scroll-area-viewport]");
    if ((await scrollViewport.count()) === 1) {
      await scrollViewport.evaluate((element) => {
        element.scrollLeft = 0;
      });
    }
    for (const fact of desktopRowFacts.filter(
      (desktopFact) => responsiveByIndex.get(desktopFact.index)?.visible,
    )) {
      const cell = row.getByRole("cell").nth(fact.index);
      const startsOutsideViewport = await cell.evaluate((element) => {
        const viewport = element.closest("[data-radix-scroll-area-viewport]");
        if (!viewport) return false;
        const cellRect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return cellRect.left < viewportRect.left || cellRect.right > viewportRect.right;
      });
      if (!startsOutsideViewport) continue;

      responsiveFactCount += 1;
      assertCondition(
        (await scrollViewport.count()) === 1,
        `${tableCase.path} clips ${fact.label} at ${width}px without a horizontal ScrollArea`,
      );
      await scrollCellIntoView(cell);
      const access = await cell.evaluate((element) => {
        const viewport = element.closest("[data-radix-scroll-area-viewport]");
        if (!viewport) return { reachable: false };
        const cellRect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return {
          reachable: (() => {
            const style = getComputedStyle(element);
            const alignsEnd = style.justifyContent === "flex-end" || style.textAlign === "right";
            return alignsEnd
              ? cellRect.right <= viewportRect.right + 1 && cellRect.right > viewportRect.left
              : cellRect.left >= viewportRect.left - 1 && cellRect.left < viewportRect.right;
          })(),
          cellLeft: cellRect.left,
          cellRight: cellRect.right,
          viewportLeft: viewportRect.left,
          viewportRight: viewportRect.right,
          scrollLeft: viewport.scrollLeft,
          scrollWidth: viewport.scrollWidth,
          clientWidth: viewport.clientWidth,
        };
      });
      assertCondition(
        access.reachable,
        `${tableCase.path} cannot scroll ${fact.label}: ${fact.value} into view at ${width}px (${JSON.stringify(access)})`,
      );
    }

    if (tableCase.path === "/org-settings/members") {
      const editableRow = table.getByRole("row").nth(2);
      const roleCell = editableRow.locator('[data-data-table-column="role"]');
      await scrollCellIntoView(roleCell);
      await roleCell.getByRole("combobox").click();
      await page.getByRole("listbox").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");

      const actionsCell = editableRow.locator('[data-data-table-column="actions"]');
      await scrollCellIntoView(actionsCell);
      await actionsCell.getByRole("button").click();
      await page.getByRole("menu").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
    }
  }

  await context.close();
}

await browser.close();
assertCondition(
  responsiveFactCount > 0,
  "the guard did not exercise a fact requiring responsive access",
);
await Bun.write(
  Bun.stdout,
  `Settings responsive information access: ${SETTINGS_TABLES.length} tables at ${RESPONSIVE_WIDTHS.join("/")}px: ok\n`,
);
