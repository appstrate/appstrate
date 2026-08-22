// SPDX-License-Identifier: Apache-2.0

/**
 * Measure a table's real geometry across a sweep of widths, and FAIL when it
 * overflows its frame.
 *
 * A capture at 1440 shows nothing wrong. This is what found the run table's
 * agent name at 6px, and the integration tables clipped inside a card: the
 * frame is `overflow-hidden` for the sake of its radius, so a table wider than
 * its container does not scroll, it is CUT, and the cut is off-screen.
 *
 * It reads the DOM the browser actually laid out — `getBoundingClientRect` per
 * cell — rather than the CSS, because the whole point is what the tracks
 * RESOLVED to, not what they asked for. Hidden cells are skipped, so the
 * columns printed at each width are the columns a reader has.
 *
 * Its blind spot is worth knowing, because a defect walked straight through it:
 * it measures COLUMNS, not what is inside them. A cell whose content refuses to
 * shrink (a `shrink-0` badge beside a truncating name) can eat a column that
 * measures perfectly. A floor protects a column from its neighbours, not a cell
 * from its own contents. Measure AND look.
 *
 * Environment:
 *   LAB_URL       base URL of the lab (default http://localhost:5175)
 *   LAB_ROUTE     path to open, hash included (default /runs)
 *   LAB_SCENARIO  lab scenario (default nominal)
 *   LAB_SELECTOR  CSS selector scoping the search, for a page with several
 *                 tables (default: the whole document)
 *   LAB_WIDTHS    comma-separated widths (default: a 16-step sweep 1440 → 390)
 */

import { chromium } from "@playwright/test";
import { parseList } from "./screens.mjs";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const ROUTE = process.env.LAB_ROUTE ?? "/runs";
const SCENARIO = process.env.LAB_SCENARIO ?? "nominal";
const SELECTOR = process.env.LAB_SELECTOR ?? "";
const WIDTHS = parseList(
  process.env.LAB_WIDTHS,
  "1440,1280,1180,1100,1024,960,900,840,768,720,660,600,540,480,420,390".split(","),
).map(Number);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 1000 } });
await context.addInitScript((s) => localStorage.setItem("appstrate-lab-scenario", s), SCENARIO);
const page = await context.newPage();
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

console.log(`${ROUTE}  scenario=${SCENARIO}${SELECTOR ? `  within ${SELECTOR}` : ""}\n`);
let overflowed = 0;

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(250);
  const measured = await page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : document;
    const table = root?.querySelector('table[role="table"]');
    if (!table) return null;
    const shown = (row) =>
      [...(row?.children ?? [])].filter((cell) => getComputedStyle(cell).display !== "none");
    const heads = shown(table.querySelector('thead [role="row"]')).map((cell) => ({
      label: cell.textContent.trim().slice(0, 8) || "·",
      width: Math.round(cell.getBoundingClientRect().width),
    }));
    return {
      table: Math.round(table.getBoundingClientRect().width),
      // `scrollWidth - clientWidth` is the amount the frame is hiding.
      overflow: Math.round(table.scrollWidth - table.clientWidth),
      heads,
    };
  }, SELECTOR);

  if (!measured) {
    console.log(`w=${String(width).padStart(4)}  no table`);
    continue;
  }
  if (measured.overflow > 0) overflowed += 1;
  const columns = measured.heads.map((h) => `${h.label}:${h.width}`).join("  ");
  console.log(
    `w=${String(width).padStart(4)}  table=${String(measured.table).padStart(4)}` +
      `  overflow=${String(measured.overflow).padStart(3)}  ${columns}`,
  );
}

await browser.close();

if (overflowed > 0) {
  console.error(
    `\nOverflows at ${overflowed} width(s). The frame is \`overflow-hidden\`, so this` +
      `\nis CLIPPED, not scrolled. Either a tier-one floor is too fat for the real` +
      `\ncontainer, or a column belongs in a later tier. Note that the container is` +
      `\nthe window MINUS the shell's gutter (348px at a 390px window), and less` +
      `\nagain for a table nested inside a card.`,
  );
  process.exit(1);
}
console.log("\nNo overflow at any width.");
