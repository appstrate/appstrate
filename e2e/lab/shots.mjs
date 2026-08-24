// SPDX-License-Identifier: Apache-2.0

/**
 * Walk the lab: every screen × scenario × width, capture each one, and FAIL on
 * a screen the lab cannot serve.
 *
 * Two jobs in one pass, because they need the same browser:
 *
 * 1. **Capture.** What the design pass looks at. Screenshots land in `LAB_OUT`.
 * 2. **The fixture guard.** `src/lab/mock-fetch.ts` logs
 *    `[lab] no fixture for GET /api/…` whenever a screen asks for an endpoint
 *    the lab has no handler for. This script listens for that line and exits
 *    non-zero. Six times in two days a screen was migrated, opened, and found
 *    showing an error instead of a rendering, and every time a human had to
 *    notice. Now it is an exit code.
 *
 * **Why runtime and not a source scan.** The obvious guard is to grep the hooks
 * for their endpoint strings and check the lab's route table covers them. It
 * does not hold: the SPA reaches the API in FOUR shapes, and only two of them
 * name their path in the source. `$api.useQuery("get", "/api/x")` and
 * `client.GET("/api/x")` do; `client.GET(`/api/packages/${cfg.path}/…`)` builds
 * the path from a variable (`hooks/use-packages.ts`), and better-auth fetches
 * `/api/auth/get-session` from inside its own client, where the SPA never
 * writes the string at all — and that one is the FIRST request the app makes.
 * A scan would miss the package endpoints and the session both. Watching the
 * browser sees all four, because it observes the fetch rather than the source.
 *
 * Environment:
 *   LAB_URL        base URL of the lab (default http://localhost:5175)
 *   LAB_SCREENS    comma-separated screen names or paths (default: all)
 *   LAB_SCENARIOS  comma-separated (default: nominal)
 *   LAB_WIDTHS     comma-separated pixel widths (default: 1440)
 *   LAB_OUT        directory for the PNGs (default: ./lab-shots)
 *   LAB_ALLOW_HOLES=1  report missing fixtures without failing
 *
 * CONSOLE CARVE-OUT: this developer CLI's human-readable stdout and stderr are
 * its interface. Application logging rules do not apply to this harness.
 */

import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { parseList, selectScreens } from "./screens.mjs";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const SCREENS = selectScreens(process.env.LAB_SCREENS);
const SCENARIOS = parseList(process.env.LAB_SCENARIOS, ["nominal"]);
const WIDTHS = parseList(process.env.LAB_WIDTHS, ["1440"]).map(Number);
const OUT = process.env.LAB_OUT ?? "./lab-shots";
const ALLOW_HOLES = process.env.LAB_ALLOW_HOLES === "1";

await mkdir(OUT, { recursive: true });

// Chrome STABLE with a throwaway profile. The MCP browser holds a lock on its
// own profile and it belongs to whichever session grabbed it first; waiting for
// that lock is what left half of this branch unlooked at. This shares nothing
// with it, so both can run at once.
const browser = await chromium.launch({ channel: "chrome" });
const holes = new Map();
const navigationFailures = [];
let shots = 0;

for (const scenario of SCENARIOS) {
  const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 1000 } });
  // The scenario lives in localStorage and both HTTP clients capture
  // `globalThis.fetch` at module-evaluation time, so it has to be set BEFORE
  // the app boots. Anything done after navigation is already too late.
  await context.addInitScript((s) => localStorage.setItem("appstrate-lab-scenario", s), scenario);
  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (!text.includes("[lab] no fixture")) return;
    const where = `${scenario} ${page.url().replace(BASE, "")}`;
    if (!holes.has(text)) holes.set(text, new Set());
    holes.get(text).add(where);
  });

  for (const screen of SCREENS) {
    // Nominal and heavy can prove the real row-link path. Empty and error have
    // no reliable source row by design, so those scenarios exercise the
    // permanent detail URL directly and prove the detail resource survives.
    if (screen.via && (scenario === "nominal" || scenario === "heavy")) {
      await page.goto(`${BASE}${screen.via.path}`, { waitUntil: "domcontentloaded" });
      const link = page.getByText(screen.via.text, { exact: true }).first();
      await link.waitFor({ state: "visible" });
      await link.click();
    } else {
      await page.goto(`${BASE}${screen.path}`, { waitUntil: "domcontentloaded" });
    }
    if (screen.settleMs) await page.waitForTimeout(screen.settleMs);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      // Long enough for the queries the screen fires on mount to answer, which
      // is also what the fixture guard is waiting for.
      await page.waitForTimeout(1200);
      if (screen.expectedText) {
        const actualPath = new URL(page.url()).pathname;
        const visible = await page
          .getByText(screen.expectedText, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        if (actualPath !== screen.path || !visible) {
          navigationFailures.push({
            screen: screen.name,
            scenario,
            width,
            expectedPath: screen.path,
            actualPath,
            expectedText: screen.expectedText,
            visible,
          });
        }
      }
      const file = `${OUT}/${screen.name}-${scenario}-${width}.png`;
      await page.screenshot({ path: file, fullPage: true });
      shots += 1;
      console.log(`  ${file}`);
    }
  }
  await context.close();
}
await browser.close();

console.log(`\n${shots} shots, ${SCREENS.length} screens × ${SCENARIOS.length} scenarios`);

if (holes.size === 0 && navigationFailures.length === 0) {
  console.log("No missing fixture.");
  process.exit(0);
}

if (navigationFailures.length > 0) {
  console.error("\nDetail navigation regression(s):\n");
  for (const failure of navigationFailures) {
    console.error(
      `  ${failure.screen} ${failure.scenario} ${failure.width}px: expected ${failure.expectedPath}` +
        ` with visible ${JSON.stringify(failure.expectedText)}, got ${failure.actualPath}` +
        ` (visible: ${failure.visible})`,
    );
  }
}

if (holes.size > 0) {
  console.error(`\n${holes.size} endpoint(s) the lab cannot serve:\n`);
  for (const [line, where] of holes) {
    console.error(`  ${line}`);
    console.error(`    seen on: ${[...where].join(", ")}`);
  }
  console.error(
    "\nA screen with no fixture is a screen nobody looks at: it can only ever be" +
      "\nseen failing. Add a row to `apps/web/src/lab/handlers.ts` and the body it" +
      "\nserves to `apps/web/src/lab/fixtures.ts`, typed as the OpenAPI response" +
      "\nfor that endpoint so a backend shape change fails typecheck on the fixture.",
  );
}
process.exit(navigationFailures.length === 0 && ALLOW_HOLES ? 0 : 1);
