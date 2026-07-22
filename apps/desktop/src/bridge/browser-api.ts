// SPDX-License-Identifier: Apache-2.0

/**
 * DOM-poll browser primitive: waitForSelector.
 *
 * click/fill moved to NATIVE CDP input in `cdp.ts` (trusted events, the
 * anti-bot-safe path). Only waitForSelector stays here — CDP has no
 * native equivalent, so it polls `document.querySelector` until the node
 * appears or the deadline passes.
 */

import type { WebContents } from "electron";

export interface WaitForSelectorParams {
  selector: string;
  timeoutMs?: number;
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
