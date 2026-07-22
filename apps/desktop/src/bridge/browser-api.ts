// SPDX-License-Identifier: Apache-2.0

/**
 * DOM-script browser primitives: click, fill, waitForSelector.
 *
 * The React-aware fill (native value setter + input/change events) and
 * the polling waitForSelector are deliberately script-based — CDP has
 * no native equivalent for either. navigate/evaluate/screenshot moved
 * to the CDP-backed implementations in `cdp.ts`, which give them real
 * load semantics, detailed exceptions and full-page capture.
 */

import type { WebContents } from "electron";

export interface ClickParams {
  selector: string;
}
export interface FillParams {
  selector: string;
  value: string;
}
export interface WaitForSelectorParams {
  selector: string;
  timeoutMs?: number;
}

export async function click(wc: WebContents, p: ClickParams): Promise<void> {
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(p.selector)});
    if (!el) throw new Error('selector not found: ' + ${JSON.stringify(p.selector)});
    el.click();
  })()`;
  await wc.executeJavaScript(script, true);
}

export async function fill(wc: WebContents, p: FillParams): Promise<void> {
  // React/MUI/Vue track input values via their own state — assigning
  // `el.value = X` bypasses the framework's setter and the controlled
  // component never sees the change. The reliable cross-framework
  // pattern: walk up to the native HTMLInputElement.prototype `value`
  // descriptor and call its setter, then fire the input + change events
  // so the framework's onChange handler still runs. Same approach used
  // by Playwright / Cypress / React Testing Library.
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(p.selector)});
    if (!el) throw new Error('selector not found: ' + ${JSON.stringify(p.selector)});
    el.focus();
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(p.value)});
    else el.value = ${JSON.stringify(p.value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`;
  await wc.executeJavaScript(script, true);
}

const DEFAULT_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export async function waitForSelector(wc: WebContents, p: WaitForSelectorParams): Promise<void> {
  const timeout = p.timeoutMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + timeout;
  const script = `!!document.querySelector(${JSON.stringify(p.selector)})`;
  while (Date.now() < deadline) {
    const found = (await wc.executeJavaScript(script, true)) as boolean;
    if (found) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`waitForSelector timed out after ${timeout}ms: ${p.selector}`);
}
