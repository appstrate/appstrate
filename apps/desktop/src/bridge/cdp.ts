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
 *   - click/fill: NATIVE input via `Input.dispatchMouseEvent` /
 *     `Input.insertText` (trusted events, `isTrusted: true`) instead of
 *     the old in-page `el.click()` / value-setter script, whose
 *     synthetic events carry `isTrusted: false` — the exact tell anti-bot
 *     vendors (DataDome, Cloudflare) key on. A DataDome-gated login POST
 *     that a scripted fill could not clear goes through once the typing
 *     is a real keyboard stream. Substitution is unchanged: the platform
 *     resolves `{{field}}` before dispatch, so the bridge types the real
 *     value and the agent still never sees it.
 *
 * Only waitForSelector stays on the DOM-poll path (browser-api.ts): CDP
 * has no native equivalent. The debugger attaches lazily on first use and
 * re-attaches transparently if something (e.g. opening DevTools, which
 * evicts other debugger clients) detached it.
 */

import { type WebContents } from "electron";

const PROTOCOL_VERSION = "1.3";

/** Ctrl on Win/Linux, Cmd on macOS — the "select all" accelerator. Bitmask per CDP Input. */
const SELECT_ALL_MODIFIER = process.platform === "darwin" ? 4 /* Meta */ : 2; /* Ctrl */

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

export interface CdpClickParams {
  selector: string;
}
export interface CdpFillParams {
  selector: string;
  value: string;
}

/**
 * Resolve a CSS selector to a CDP nodeId (DOM domain must be enabled by
 * the caller). Throws the same "selector not found" the old script did.
 */
async function resolveNode(wc: WebContents, selector: string): Promise<number> {
  const { root } = (await wc.debugger.sendCommand("DOM.getDocument", { depth: 0 })) as {
    root: { nodeId: number };
  };
  const { nodeId } = (await wc.debugger.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  })) as { nodeId: number };
  if (!nodeId) throw new Error(`selector not found: ${selector}`);
  return nodeId;
}

/**
 * Native click: scroll the element into view, read its box from the DOM
 * (not a page script), and dispatch a real move → press → release mouse
 * sequence at its centre. The events are trusted, indistinguishable from
 * a human pointer — the whole reason this replaces `el.click()`.
 */
export async function click(wc: WebContents, p: CdpClickParams): Promise<null> {
  return withDebugger(wc, async () => {
    await wc.debugger.sendCommand("DOM.enable");
    const nodeId = await resolveNode(wc, p.selector);
    await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { nodeId });
    const { model } = (await wc.debugger.sendCommand("DOM.getBoxModel", { nodeId })) as {
      model: { content: number[] };
    };
    // content is a quad [x1,y1, x2,y2, x3,y3, x4,y4]; centre = mean of opposite corners.
    const q = model.content;
    const x = (q[0]! + q[4]!) / 2;
    const y = (q[1]! + q[5]!) / 2;
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    return null;
  });
}

/**
 * Native fill: focus the field, select any existing content with the
 * platform's select-all accelerator, then stream the value through
 * `Input.insertText`. insertText fires real beforeinput/input events at
 * the browser level, so React/Vue controlled inputs see the change AND
 * the events are trusted. Value arrives already substituted — the bridge
 * types the real secret, the agent never holds it.
 */
export async function fill(wc: WebContents, p: CdpFillParams): Promise<null> {
  return withDebugger(wc, async () => {
    await wc.debugger.sendCommand("DOM.enable");
    const nodeId = await resolveNode(wc, p.selector);
    await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { nodeId });
    await wc.debugger.sendCommand("DOM.focus", { nodeId });
    // Select existing content (Ctrl/Cmd+A) so insertText replaces it.
    for (const type of ["keyDown", "keyUp"] as const) {
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: SELECT_ALL_MODIFIER,
      });
    }
    await wc.debugger.sendCommand("Input.insertText", { text: p.value });
    return null;
  });
}

export interface CdpSelectOptionParams {
  selector: string;
  /** Match an <option> by its `value` attribute. */
  value?: string;
  /** Match an <option> by its visible text. */
  label?: string;
}

/**
 * Set a native `<select>`. Unlike click/fill there is no lower-level
 * path: a native select's dropdown is an OS-drawn popup, not DOM, so no
 * automation tool (Playwright/Puppeteer included) drives it with the
 * mouse — they all set `value` and fire `change`. We do the same through
 * `Runtime.evaluate` (CDP transport, a minimal DOM write). A `<select>`
 * change carries no keystroke/pointer timing, so it is not an anti-bot
 * vector. Custom (div/listbox) dropdowns are NOT this: their options are
 * real DOM, so drive them with `browser.click` (open, then click option).
 */
export async function selectOption(
  wc: WebContents,
  p: CdpSelectOptionParams,
): Promise<{ selected: string; label: string }> {
  if (p.value === undefined && p.label === undefined) {
    throw new Error("selectOption requires `value` or `label`");
  }
  return withDebugger(wc, async () => {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(p.selector)});
      if (!el) throw new Error('selector not found: ' + ${JSON.stringify(p.selector)});
      if (el.tagName !== 'SELECT') throw new Error('selectOption target is not a <select>: ' + ${JSON.stringify(p.selector)});
      const opts = Array.from(el.options);
      const wantValue = ${JSON.stringify(p.value ?? null)};
      const wantLabel = ${JSON.stringify(p.label ?? null)};
      let opt = null;
      if (wantValue !== null) opt = opts.find(o => o.value === wantValue) || null;
      if (!opt && wantLabel !== null) opt = opts.find(o => (o.textContent || '').trim() === wantLabel) || null;
      if (!opt && wantValue !== null) opt = opts.find(o => (o.textContent || '').trim() === wantValue) || null;
      if (!opt) throw new Error('no <option> matching value=' + wantValue + ' label=' + wantLabel);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: opt.value, label: (opt.textContent || '').trim() };
    })()`;
    const res = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    })) as {
      result?: { value?: { selected: string; label: string } };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "selectOption failed",
      );
    }
    return res.result?.value ?? { selected: "", label: "" };
  });
}
