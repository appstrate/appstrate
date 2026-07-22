// SPDX-License-Identifier: Apache-2.0

/**
 * CDP-backed browser primitives.
 *
 * Electron exposes the Chrome DevTools Protocol on its own WebContents
 * (`webContents.debugger`) — the same protocol Playwright, Puppeteer and
 * the DevTools speak. Three primitives ride it, because it gives them
 * semantics the plain Electron APIs cannot:
 *
 *   - navigate: a REAL "page loaded" signal (`Page.loadEventFired`)
 *     instead of returning at dispatch — with a soft timeout, because
 *     long-polling pages may never fire it and the old always-immediate
 *     behavior must remain the worst case, not a hang.
 *   - evaluate: `Runtime.evaluate` surfaces the thrown exception with
 *     its description and line number instead of an opaque failure.
 *   - screenshot: `Page.captureScreenshot` adds full-page capture and
 *     format/quality control.
 *
 * fill/click/waitForSelector stay on the DOM-script path (browser-api.ts):
 * CDP has no native waitForSelector, and the React-aware fill script is
 * battle-tested. The debugger attaches lazily on first use and
 * re-attaches transparently if something (e.g. opening DevTools, which
 * evicts other debugger clients) detached it.
 */

import type { WebContents } from "electron";

const PROTOCOL_VERSION = "1.3";

/**
 * Run `fn` with the debugger attached, then DETACH immediately.
 *
 * A permanently attached debugger is an automation tell: Cloudflare
 * Turnstile stopped auto-solving on the login pages the moment lot-4
 * shipped with a persistent attach, and anti-bot vendors document CDP
 * detection. Keeping the attach window to a sub-second burst — and
 * never during page boot, which is when challenges probe — removes
 * the signal while keeping CDP's semantics for evaluate/screenshot.
 */
async function withDebugger<T>(wc: WebContents, fn: () => Promise<T>): Promise<T> {
  const wasAttached = wc.debugger.isAttached();
  if (!wasAttached) wc.debugger.attach(PROTOCOL_VERSION);
  try {
    return await fn();
  } finally {
    if (!wasAttached) {
      try {
        wc.debugger.detach();
      } catch {
        // already detached (DevTools eviction) — nothing to release
      }
    }
  }
}

export interface CdpNavigateParams {
  url: string;
  /** How long to wait for the load event before returning `loaded: false` (default 10s). */
  timeoutMs?: number;
}

/**
 * Navigate and wait for `Page.loadEventFired`, up to `timeoutMs`. A page
 * that never fires load (long-polling, streaming) resolves with
 * `loaded: false` after the timeout — never an error, so the historical
 * "returns and lets the agent poll" behavior is the floor, not a hang.
 * Hard navigation failures (DNS, refused) reject with the CDP errorText.
 */
export async function navigate(
  wc: WebContents,
  p: CdpNavigateParams,
): Promise<{ url: string; loaded: boolean }> {
  // Deliberately NOT CDP: page boot is exactly when anti-bot challenges
  // probe for automation signals, so no debugger may be attached here.
  // Electron's own load events give the same `loaded` semantics.
  const timeoutMs = Math.min(Math.max(p.timeoutMs ?? 10_000, 500), 60_000);
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onLoad = (): void => {
      cleanup();
      resolve(true);
    };
    const onFail = (): void => {
      cleanup();
      resolve(false);
    };
    function cleanup(): void {
      clearTimeout(timer);
      wc.off("did-finish-load", onLoad);
      wc.off("did-fail-load", onFail);
    }
    wc.on("did-finish-load", onLoad);
    wc.on("did-fail-load", onFail);
  });
  await wc.loadURL(p.url).catch((err: Error & { errno?: number; code?: string }) => {
    // loadURL rejects on hard navigation failures (DNS, refused) — keep
    // that signal — but ERR_ABORTED just means a redirect took over.
    if (err.code !== "ERR_ABORTED")
      throw new Error(`navigation failed: ${err.code ?? err.message}`);
  });
  return { url: p.url, loaded: await loaded };
}

export interface CdpEvaluateParams {
  script: string;
}

/**
 * Evaluate through `Runtime.evaluate` (awaits promises, returns by
 * value). A thrown exception surfaces with its description and position
 * — the agent sees WHAT broke and WHERE instead of an opaque failure.
 */
export async function evaluate(wc: WebContents, p: CdpEvaluateParams): Promise<unknown> {
  return withDebugger(wc, async () => {
    const res = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression: p.script,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: {
        text?: string;
        lineNumber?: number;
        exception?: { description?: string };
      };
    };
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const description = d.exception?.description ?? d.text ?? "script threw";
      const line = d.lineNumber !== undefined ? ` (line ${d.lineNumber + 1})` : "";
      throw new Error(`${description}${line}`);
    }
    return res.result?.value ?? null;
  });
}

export interface CdpScreenshotParams {
  /** Capture the full scrollable page, not just the viewport. */
  fullPage?: boolean;
  format?: "png" | "jpeg";
  /** JPEG quality 0-100 (ignored for png). */
  quality?: number;
}

export async function screenshot(
  wc: WebContents,
  p: CdpScreenshotParams = {},
): Promise<{ dataUrl: string }> {
  return withDebugger(wc, async () => {
    const format = p.format === "jpeg" ? "jpeg" : "png";
    const res = (await wc.debugger.sendCommand("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" && p.quality !== undefined
        ? { quality: Math.min(Math.max(p.quality, 0), 100) }
        : {}),
      ...(p.fullPage ? { captureBeyondViewport: true } : {}),
    })) as { data: string };
    return { dataUrl: `data:image/${format};base64,${res.data}` };
  });
}
