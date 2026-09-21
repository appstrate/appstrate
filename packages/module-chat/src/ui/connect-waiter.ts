// SPDX-License-Identifier: Apache-2.0

/**
 * When the connect card may settle — pure (no React, no DOM) so the ordering
 * rules are testable without a browser.
 *
 * The two kinds of signal mean different things:
 *  - the completion message (`postMessage` / `BroadcastChannel`) is the connect
 *    page saying the flow is OVER; it settles at once.
 *  - the SSE `connection_update` only says the connection ROW exists. For a
 *    credential the platform provisions (SSH), the row exists while the connect
 *    page is still showing the install block the user has to run on the target;
 *    resuming then sends the agent at a host that does not trust the key yet.
 *
 * So an SSE hit settles only once the popup this card opened is gone: the SSE
 * is the backstop for a lost message, and a message can only be lost for good
 * once the window that would send it has closed. A handle severed by a
 * cross-origin-isolated provider page reads `closed`, which is exactly the case
 * where its `postMessage` cannot reach us either. The gate reads nothing but
 * that window, so the SSE frame and the page's own signals may arrive in any
 * order; the connect page's "held open" broadcast is not consulted.
 *
 * The gate covers the card's OWN popup only. When the card holds no handle —
 * the button was never clicked (the form was opened elsewhere, e.g. on another
 * device) or the browser blocked the popup — an SSE hit settles at once, which
 * for a provisioned credential can precede the key's installation on the
 * target. The model never receives the connect URL, so the card's button is the
 * path a user normally takes.
 */

import type { CompletionDetail } from "./auth-offer.ts";

/** The part of a `Window` handle the waiter reads. */
export interface PopupHandle {
  readonly closed: boolean;
}

/** Run `fn` every `ms`; returns the canceller. Injected so tests drive time. */
export type Every = (fn: () => void, ms: number) => () => void;

const POPUP_POLL_MS = 500;

const everyInterval: Every = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export interface ConnectWaiter {
  /** Where a settlement goes — rebound whenever the card's callback changes. */
  bind(settle: (ok: boolean, error?: string) => void): void;
  /** The card opened `popup` (null when the browser blocked it). */
  popupOpened(popup: PopupHandle | null): void;
  /** A completion message addressed to this card arrived. */
  completion(detail: CompletionDetail): void;
  /** The SSE backstop saw this card's connection row appear. */
  connectionSeen(): void;
  /** Stop polling; the waiter stays usable (a StrictMode remount reuses it). */
  stop(): void;
  /** Restart polling for an SSE hit parked before {@link stop}; called on mount. */
  resume(): void;
}

export function createConnectWaiter(every: Every = everyInterval): ConnectWaiter {
  let settle: (ok: boolean, error?: string) => void = () => {};
  let popup: PopupHandle | null = null;
  let seen = false;
  let settled = false;
  let cancelPoll: (() => void) | null = null;

  const stop = () => {
    cancelPoll?.();
    cancelPoll = null;
  };
  const popupOpen = () => popup !== null && !popup.closed;

  const settleIfSeen = () => {
    if (settled || !seen || popupOpen()) return;
    settled = true;
    stop();
    settle(true);
  };
  const poll = () => {
    settleIfSeen();
    if (seen && !settled && !cancelPoll) cancelPoll = every(settleIfSeen, POPUP_POLL_MS);
  };

  return {
    bind(fn) {
      settle = fn;
    },
    popupOpened(p) {
      popup = p;
    },
    completion(detail) {
      if (settled) return;
      const ok = detail.ok !== false;
      // A failure leaves the card retryable, so only success is final.
      if (ok) {
        settled = true;
        stop();
      }
      settle(ok, detail.error);
    },
    connectionSeen() {
      seen = true;
      poll();
    },
    stop,
    resume: poll,
  };
}
