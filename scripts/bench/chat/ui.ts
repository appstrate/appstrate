// SPDX-License-Identifier: Apache-2.0

/**
 * The browser half of the chat bench: a real Chromium sends a message through
 * the SPA's composer and the page itself timestamps what the user sees — the
 * thinking dots, a blank bubble, the first answer word — plus how smoothly the
 * stream renders (long tasks, slow frames).
 *
 * Needs the mock upstream: its answer (`lorem …`) is what makes the text
 * detectable without knowing the DOM structure. Playwright is
 * the e2e workspace's own install, typed here by the few calls the bench makes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BenchUser } from "./client.ts";

export interface UiTimings {
  /** All `*Ms`: ms after the SPA issued `POST /api/chat`. */
  dotsMs: number | null;
  firstTextMs: number | null;
  lastTextMs: number | null;
  streamEndMs: number | null;
  /** Time, before the first answer word, with neither the thinking dots nor text on screen. */
  blankMs: number | null;
  longTasks: number | null;
  longTaskMs: number | null;
  /** Frames slower than 50 ms between the first answer word and the end of the stream. */
  slowFrames: number | null;
  maxFrameMs: number | null;
  error: string | null;
}

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  getByPlaceholder(text: string): { fill(v: string): Promise<void>; waitFor(): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
  waitForFunction(fn: string, arg: undefined, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
}

/** What `ui-instrument.js` leaves on `window.__bench` (`performance.now()` stamps). */
interface PageStamps {
  sendAt: number;
  dotsAt: number | null;
  textAt: number | null;
  lastTextAt: number | null;
  streamEndAt: number | null;
  blank: number;
  frames: number[];
  longTasks: number;
  longTaskMs: number;
}

const COMPOSER_PLACEHOLDER = "Message Appstrate…";
const SLOW_FRAME_MS = 50;

export interface Browser {
  /** One turn in a fresh browser context; failures come back in `error`. */
  turn(origin: string, user: BenchUser, prompt: string, expectedWords: number): Promise<UiTimings>;
  close(): Promise<void>;
}

export async function openBrowser(repoRoot: string): Promise<Browser> {
  const entry = join(repoRoot, "e2e/node_modules/@playwright/test/index.js");
  if (!existsSync(entry)) {
    throw new Error(
      "the ui scenario drives e2e's Playwright: `bun install`, then `cd e2e && npx playwright install chromium`",
    );
  }
  const { chromium } = (await import(entry)) as {
    chromium: { launch(opts: { headless: boolean }): Promise<PlaywrightBrowser> };
  };
  // Read before the launch: a failed read must not leave a Chromium behind.
  const instrument = await Bun.file(join(import.meta.dir, "ui-instrument.js")).text();
  const browser = await chromium.launch({ headless: true });

  async function turn(
    origin: string,
    user: BenchUser,
    prompt: string,
    expectedWords: number,
  ): Promise<UiTimings> {
    const context = await browser.newContext();
    try {
      await context.addCookies(
        user.cookie.split("; ").map((pair) => {
          const i = pair.indexOf("=");
          return { name: pair.slice(0, i), value: pair.slice(i + 1), url: origin };
        }),
      );
      await context.addInitScript({
        content: `localStorage.setItem("appstrate_current_org", ${JSON.stringify(user.orgId)});
${instrument}`,
      });
      const page = await context.newPage();
      await page.goto(`${origin}/chat`);
      const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
      await composer.waitFor();
      await composer.fill(prompt);
      await page.keyboard.press("Enter");
      // Done when the stream has ended and the whole answer is on screen (or
      // has had 1.5 s to render after the end, for an answer shorter than expected).
      await page.waitForFunction(
        `(() => { const b = window.__bench; return b.streamEndAt !== null && (b.textLength >= ${expectedWords} || performance.now() - b.streamEndAt > 1500); })()`,
        undefined,
        { timeout: 60_000 },
      );
      const b = await page.evaluate<PageStamps>("window.__bench");
      const rel = (t: number | null) => (t === null ? null : t - b.sendAt);
      return {
        dotsMs: rel(b.dotsAt),
        firstTextMs: rel(b.textAt),
        lastTextMs: rel(b.lastTextAt),
        streamEndMs: rel(b.streamEndAt),
        blankMs: b.blank,
        longTasks: b.longTasks,
        longTaskMs: b.longTaskMs,
        slowFrames: b.frames.filter((d) => d > SLOW_FRAME_MS).length,
        maxFrameMs: b.frames.length ? Math.max(...b.frames) : 0,
        error: null,
      };
    } catch (err) {
      return {
        dotsMs: null,
        firstTextMs: null,
        lastTextMs: null,
        streamEndMs: null,
        blankMs: null,
        longTasks: null,
        longTaskMs: null,
        slowFrames: null,
        maxFrameMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await context.close();
    }
  }

  return { turn, close: () => browser.close() };
}
