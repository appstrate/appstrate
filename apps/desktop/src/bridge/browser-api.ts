// SPDX-License-Identifier: Apache-2.0

/**
 * Thin wrappers over `webContents` that expose the 6 browser primitives
 * the remote Appstrate agent can call through the bridge.
 *
 * Kept intentionally minimal — anything more elaborate (frame targeting,
 * cookie introspection, request interception) belongs in a v2 protocol
 * after the POC validates the round-trip.
 */

import type { WebContents } from "electron";

export interface NavigateParams {
  url: string;
  timeoutMs?: number;
}
export interface ClickParams {
  selector: string;
}
export interface FillParams {
  selector: string;
  value: string;
}
export interface EvaluateParams {
  script: string;
}
export interface WaitForSelectorParams {
  selector: string;
  timeoutMs?: number;
}

export async function navigate(wc: WebContents, p: NavigateParams): Promise<{ url: string }> {
  // Don't `await wc.loadURL()` — its Promise resolves on `did-finish-load`,
  // which never fires cleanly on modern pages that keep open long-polling
  // sockets (analytics, hot-reload, presence channels). The HTTP caller
  // would always time out. We fire the navigation and return as soon as
  // it's been dispatched; the agent observes completion via
  // `waitForSelector` or `screenshot` if it needs to.
  wc.loadURL(p.url).catch(() => {
    // Ignore loadURL rejections — they fire on navigation aborts (e.g.
    // user clicks a link while we're loading), not on user-visible errors.
  });
  return { url: p.url };
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

export async function evaluate(wc: WebContents, p: EvaluateParams): Promise<unknown> {
  return wc.executeJavaScript(p.script, true);
}

export async function screenshot(wc: WebContents): Promise<{ dataUrl: string }> {
  const image = await wc.capturePage();
  return { dataUrl: image.toDataURL() };
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
