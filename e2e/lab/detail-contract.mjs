// SPDX-License-Identifier: Apache-2.0

/**
 * Freeze the accepted desktop rendering of Agent and Run detail surfaces.
 *
 * This guard serializes the geometry and computed styles that Chrome actually
 * rendered, checks structural and overflow invariants, saves reusable PNGs and
 * compares the result with a checked-in JSON contract. It does not use PNGs as
 * a blocking baseline: font rasterization, Chrome builds and OS antialiasing
 * make pixel diffs noisy across developer machines and CI. The JSON contract
 * protects layout and surface grammar without binding refactors to DOM wrappers.
 *
 * Baselines are never regenerated implicitly. Use LAB_DETAIL_UPDATE=1, inspect
 * both the JSON diff and the PNGs, then commit the baseline intentionally.
 *
 * Environment:
 *   LAB_URL                 lab base URL (default http://localhost:5175)
 *   LAB_DETAIL_SCREENS      comma-separated screen names or paths
 *   LAB_DETAIL_WIDTHS       comma-separated widths (default 1440,1280,1024)
 *   LAB_DETAIL_SCENARIO     lab scenario (default nominal)
 *   LAB_DETAIL_OUT          PNG/actual JSON directory (default ./lab-detail-shots)
 *   LAB_DETAIL_BASELINE     baseline JSON path
 *   LAB_DETAIL_UPDATE=1     explicitly replace the baseline
 *   LAB_DETAIL_TOLERANCE    geometry tolerance in pixels (default 1)
 *   LAB_DETAIL_TIMEOUT      layout stabilization timeout in ms (default 12000)
 *
 * CONSOLE CARVE-OUT: this developer CLI's stdout and stderr are its interface.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  CONTRACT_VERSION,
  assertRenderedInvariants,
  compareContracts,
  contractKey,
  normalizeLandmarkLabel,
} from "./detail-contract-core.mjs";
import { parseList, selectScreens } from "./screens.mjs";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const WIDTHS = parseList(process.env.LAB_DETAIL_WIDTHS, ["1440", "1280", "1024"]).map(Number);
const SCENARIO = process.env.LAB_DETAIL_SCENARIO ?? "nominal";
const OUT = process.env.LAB_DETAIL_OUT ?? "./lab-detail-shots";
const BASELINE = process.env.LAB_DETAIL_BASELINE ?? "./lab/baselines/agent-run-desktop.json";
const UPDATE = process.env.LAB_DETAIL_UPDATE === "1";
const TOLERANCE = Number(process.env.LAB_DETAIL_TOLERANCE ?? "1");
const STABILITY_TIMEOUT = Number(process.env.LAB_DETAIL_TIMEOUT ?? "12000");

const DEFAULT_SCREEN_NAMES = [
  "agent-overview",
  "agent-overview-warning",
  "agent-overview-blocking",
  "agent-map",
  "agent-map-warning",
  "agent-map-blocking",
  "agent-runs",
  "agent-configuration",
  "agent-memory",
  "agent-files",
  "run-overview-active",
  "run-overview-turns-modal",
  "run-overview-success",
  "run-overview-empty-input",
  "run-results-active",
  "run-results-success",
  "run-results-cancelled-partial",
  "run-results-inline",
  "run-journal-search-open",
  "run-journal-filter-open",
  "run-journal-search-empty",
  "run-journal-success",
  "run-journal-failed",
  "run-journal-success-empty",
  "run-journal-failed-empty",
];

const SCREEN_SPEC = process.env.LAB_DETAIL_SCREENS ?? DEFAULT_SCREEN_NAMES.join(",");
const SCREENS = selectScreens(SCREEN_SPEC);

if (SCREENS.length === 0) throw new Error(`LAB_DETAIL_SCREENS selected no screen: ${SCREEN_SPEC}`);
if (WIDTHS.some((width) => !Number.isFinite(width) || width < 800)) {
  throw new Error(`LAB_DETAIL_WIDTHS must contain desktop pixel widths, got: ${WIDTHS.join(",")}`);
}
if (!Number.isFinite(TOLERANCE) || TOLERANCE < 0) {
  throw new Error(`LAB_DETAIL_TOLERANCE must be a positive number, got ${TOLERANCE}`);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const holes = new Map();
const failures = [];
const entries = {};

function deduplicateStyles(contractEntries) {
  const styles = {};
  for (const entry of Object.values(contractEntries)) {
    for (const landmark of entry.landmarks) {
      const serialized = JSON.stringify(landmark.style);
      const id = createHash("sha256").update(serialized).digest("hex").slice(0, 12);
      const existing = styles[id];
      if (existing && JSON.stringify(existing) !== serialized) {
        throw new Error(`Computed-style digest collision for ${id}`);
      }
      styles[id] = landmark.style;
      landmark.style = id;
    }
  }
  return Object.fromEntries(
    Object.entries(styles).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function rememberHole(text, screen, width) {
  if (!holes.has(text)) holes.set(text, new Set());
  holes.get(text).add(`${screen} ${width}px`);
}

async function runScreenSteps(page, screen) {
  // Several coverage rows intentionally address the same URL with different
  // UI state. Navigating from a URL to itself does not guarantee a document
  // reload, so an open Radix submenu can leak into the next capture. A blank
  // document makes every screen an independent mount while the context keeps
  // the selected lab scenario in localStorage.
  await page.goto("about:blank");
  if (screen.via) {
    await page.goto(`${BASE}${screen.via.path}`, { waitUntil: "domcontentloaded" });
    const link = page.getByText(screen.via.text, { exact: true }).first();
    await link.waitFor({ state: "visible" });
    await link.click();
  } else {
    await page.goto(`${BASE}${screen.path}`, { waitUntil: "domcontentloaded" });
  }
  // A spinner has stable geometry too, so stability alone is not evidence that
  // the detail route finished mounting. The accepted Agent and Run shells both
  // expose their local destination tablist once the authored resource exists.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('main [role="tablist"]')].some((tablist) => {
        const labels = [...tablist.querySelectorAll('[role="tab"]')].map((tab) =>
          (tab.textContent ?? "").trim(),
        );
        return (
          labels.includes("Vue d’ensemble") &&
          (labels.includes("Paramètres") || labels.includes("Journal"))
        );
      }),
    { timeout: STABILITY_TIMEOUT },
  );
  const expectedUrl = new URL(`${BASE}${screen.path}`);
  const actualUrl = new URL(page.url());
  const expectedRoute = `${expectedUrl.pathname}${expectedUrl.search}${expectedUrl.hash}`;
  const actualRoute = `${actualUrl.pathname}${actualUrl.search}${actualUrl.hash}`;
  if (actualRoute !== expectedRoute) {
    throw new Error(`detail route changed: expected ${expectedRoute}, got ${actualRoute}`);
  }
  if (screen.settleMs) await page.waitForTimeout(screen.settleMs);
  if (screen.clickText) {
    const target = page.getByText(screen.clickText, { exact: true }).first();
    await target.waitFor({ state: "visible" });
    await target.click();
  }
  for (const step of screen.steps ?? []) {
    if (step.type === "clickLabel") {
      const target = page.getByLabel(step.label, { exact: true }).first();
      await target.waitFor({ state: "visible" });
      await target.click();
    } else if (step.type === "clickText") {
      const target = page.getByText(step.text, { exact: true }).first();
      await target.waitFor({ state: "visible" });
      await target.click();
    } else if (step.type === "fillTextbox") {
      const target = page.getByRole("textbox", { name: step.label, exact: true }).first();
      await target.waitFor({ state: "visible" });
      await target.fill(step.value);
    }
  }
}

async function waitForStableLayout(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => {
      const stateKey = "__appstrateDetailContractStability";
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const candidates = document.querySelectorAll(
        'main, main [role="tablist"], main [role="tabpanel"], main h1, main h2, main h3, main table, [role="dialog"]',
      );
      const layout = [...candidates].filter(visible).map((element) => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height].map(
          (number) => Math.round(number * 2) / 2,
        );
      });
      const fingerprint = JSON.stringify([
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        layout,
      ]);
      const previous = window[stateKey];
      const now = performance.now();
      if (!previous || previous.fingerprint !== fingerprint) {
        window[stateKey] = { fingerprint, since: now };
        return false;
      }
      return now - previous.since >= 500;
    },
    { polling: 100, timeout: STABILITY_TIMEOUT },
  );
}

async function serialize(page, screen, width) {
  const entry = await page.evaluate(
    ({ screenName, screenPath, viewportWidth }) => {
      const round = (number) => Math.round(number * 2) / 2;
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: round(rect.x + scrollX),
          y: round(rect.y + scrollY),
          width: round(rect.width),
          height: round(rect.height),
        };
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const normalizedText = (value) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 96);
      const styleOf = (element, kind) => {
        const style = getComputedStyle(element);
        // Positional arrays keep the checked-in baseline compact. Field order:
        // display, background, four border widths, border colour, radius,
        // shadow, four paddings, gap, overflow x/y, then optional typography
        // and grid tracks.
        const result = [
          style.display,
          style.backgroundColor,
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
          style.borderTopColor,
          style.borderRadius,
          style.boxShadow,
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
          style.gap,
          style.overflowX,
          style.overflowY,
        ];
        if (["heading", "tab", "button", "link", "columnheader"].includes(kind)) {
          result.push(style.color, style.fontSize, style.fontWeight, style.lineHeight);
        }
        if (style.display === "grid") result.push(style.gridTemplateColumns);
        return result;
      };
      const main = document.querySelector("main");
      if (!main) throw new Error("Agent/Run contract could not find <main>");

      const localTablists = [...main.querySelectorAll('[role="tablist"]')].filter((tablist) => {
        if (!visible(tablist)) return false;
        const labels = [...tablist.querySelectorAll('[role="tab"]')].map((tab) =>
          normalizedText(tab.textContent),
        );
        return (
          labels.includes("Vue d’ensemble") &&
          (labels.includes("Paramètres") || labels.includes("Journal"))
        );
      });
      const localTabs = localTablists.flatMap((tablist) =>
        [...tablist.querySelectorAll('[role="tab"]')].filter(visible),
      );
      const activePanels = [...main.querySelectorAll('[role="tabpanel"]')].filter(visible);
      const roots = [main, ...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const landmarkCandidates = [];
      const add = (element, kind, label = "") => {
        if (!element || !visible(element)) return;
        landmarkCandidates.push({ element, kind, label: normalizedText(label) });
      };

      add(main, "main", "main");
      for (const tablist of localTablists) add(tablist, "tablist", "Agent/Run detail");
      for (const tab of localTabs) add(tab, "tab", tab.textContent);
      for (const panel of activePanels) add(panel, "tabpanel", "active");
      for (const root of roots) {
        for (const heading of root.querySelectorAll("h1, h2, h3")) {
          add(heading, "heading", heading.textContent);
        }
        for (const button of root.querySelectorAll('button, [role="button"]')) {
          add(
            button,
            "button",
            button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent,
          );
        }
        for (const link of root.querySelectorAll("a[href]")) {
          add(link, "link", link.getAttribute("aria-label") || link.textContent);
        }
        for (const table of root.querySelectorAll('table, [role="table"]')) add(table, "table");
        for (const header of root.querySelectorAll('th, [role="columnheader"]')) {
          add(header, "columnheader", header.textContent);
        }
        for (const dialog of root.querySelectorAll('[role="dialog"]')) {
          add(dialog, "dialog", dialog.getAttribute("aria-label") || "dialog");
        }
        for (const element of root.querySelectorAll("div, section, article")) {
          if (!visible(element)) continue;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const hasFrame =
            Number.parseFloat(style.borderTopWidth) > 0 ||
            style.boxShadow !== "none" ||
            (Number.parseFloat(style.borderRadius) >= 6 &&
              style.backgroundColor !== "rgba(0, 0, 0, 0)");
          if (hasFrame && rect.width * rect.height >= 1500) add(element, "surface");
        }
      }

      const seenElements = new Set();
      const landmarks = [];
      for (const candidate of landmarkCandidates) {
        if (seenElements.has(candidate.element)) continue;
        seenElements.add(candidate.element);
        landmarks.push({
          kind: candidate.kind,
          label: candidate.label,
          rect: rectOf(candidate.element),
          style: styleOf(candidate.element, candidate.kind),
        });
      }

      const clippedInteractiveCount = [...main.querySelectorAll("button, a[href], input, select")]
        .filter(visible)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        }).length;

      return {
        screen: screenName,
        path: screenPath,
        width: viewportWidth,
        document: {
          viewportWidth: document.documentElement.clientWidth,
          viewportOverflow: round(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          mainOverflow: round(main.scrollWidth - main.clientWidth),
          clippedInteractiveCount,
          localTablistCount: localTablists.length,
          activeLocalTabCount: localTabs.filter(
            (tab) => tab.getAttribute("data-state") === "active",
          ).length,
        },
        landmarks,
      };
    },
    { screenName: screen.name, screenPath: screen.path, viewportWidth: width },
  );
  const ordinals = new Map();
  for (const landmark of entry.landmarks) {
    const label = normalizeLandmarkLabel(landmark.label);
    const base = label ? `${landmark.kind}:${label}` : landmark.kind;
    const ordinal = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, ordinal);
    landmark.key = ordinal === 1 ? base : `${base}:${ordinal}`;
    delete landmark.label;
  }
  return entry;
}

try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(
      (scenario) => localStorage.setItem("appstrate-lab-scenario", scenario),
      SCENARIO,
    );
    const page = await context.newPage();
    let activeScreen = "navigation";
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[lab] no fixture")) rememberHole(text, activeScreen, width);
    });

    for (const screen of SCREENS) {
      activeScreen = screen.name;
      try {
        await runScreenSteps(page, screen);
        await waitForStableLayout(page);
        const entry = await serialize(page, screen, width);
        failures.push(...assertRenderedInvariants(entry));
        entries[contractKey(screen.name, width)] = entry;
        const shot = resolve(OUT, `${screen.name}-${SCENARIO}-${width}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`  ${screen.name} ${width}px`);
      } catch (error) {
        failures.push(`${screen.name} at ${width}px: ${error.message}`);
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const styles = deduplicateStyles(entries);
const actual = {
  version: CONTRACT_VERSION,
  scenario: SCENARIO,
  widths: WIDTHS,
  screens: SCREENS.map((screen) => screen.name),
  // Landmarks reference these computed-style tuples by a content digest. The
  // same tuple appears hundreds of times across widths and screens; storing it
  // once keeps the reviewed baseline small without weakening the comparison.
  styles,
  entries,
};
await writeFile(
  resolve(OUT, "agent-run-desktop.actual.json"),
  `${JSON.stringify(actual, null, 2)}\n`,
);

if (holes.size > 0) {
  for (const [line, locations] of holes) {
    failures.push(`${line} (${[...locations].join(", ")})`);
  }
}

if (UPDATE) {
  if (failures.length > 0) {
    console.error("\nBaseline not updated because the rendered invariants failed:\n");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  await mkdir(dirname(resolve(BASELINE)), { recursive: true });
  await writeFile(resolve(BASELINE), `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`\nUpdated ${BASELINE} explicitly. Review its diff and the PNGs before committing.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(resolve(BASELINE), "utf8"));
} catch (error) {
  failures.push(
    `Could not read ${BASELINE}: ${error.message}. Regenerate only with LAB_DETAIL_UPDATE=1.`,
  );
}
if (baseline) failures.push(...compareContracts(baseline, actual, { tolerance: TOLERANCE }));

if (failures.length > 0) {
  console.error(`\nAgent/Run desktop contract failed with ${failures.length} difference(s):\n`);
  for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
  if (failures.length > 100) console.error(`  … ${failures.length - 100} more`);
  console.error(`\nActual contract and review PNGs: ${resolve(OUT)}`);
  process.exit(1);
}

console.log(
  `\nAgent/Run desktop contract matches ${SCREENS.length} screen(s) at ${WIDTHS.join(", ")}px.`,
);
