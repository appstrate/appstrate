// SPDX-License-Identifier: Apache-2.0

/**
 * When the connect card may resume after a success (completion message or SSE
 * `connection_update`): only once the card's own popup is closed, because an SSH
 * connection exists while that popup still shows the install block to run on
 * the target. Limit: a card holding no popup handle (never clicked, popup
 * blocked) settles at once, which can precede the key's installation.
 * The waiter can call `onConnected` again after settling; the card's `resumed`
 * flag is what keeps a second resume out.
 */

import type { IntegrationConnectCompletion } from "@appstrate/core/connect-handshake";

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
  bind(onConnected: () => void): void;
  /** The card opened `popup` (null when the browser blocked it). */
  popupOpened(popup: PopupHandle | null): void;
  /** A success signal for this card arrived. */
  connected(): void;
  /** Stop polling; {@link resume} restarts it (a StrictMode remount reuses the waiter). */
  stop(): void;
  resume(): void;
}

export function createConnectWaiter(every: Every = everyInterval): ConnectWaiter {
  let onConnected = () => {};
  let popup: PopupHandle | null = null;
  let seen = false;
  let cancelPoll: (() => void) | null = null;

  const stop = () => {
    cancelPoll?.();
    cancelPoll = null;
  };
  const check = () => {
    if (!seen || (popup && !popup.closed)) return;
    seen = false;
    stop();
    onConnected();
  };
  const resume = () => {
    check();
    if (seen && !cancelPoll) cancelPoll = every(check, POPUP_POLL_MS);
  };

  return {
    bind(fn) {
      onConnected = fn;
    },
    popupOpened(p) {
      popup = p;
    },
    connected() {
      seen = true;
      resume();
    },
    stop,
    resume,
  };
}

/**
 * A failure reaches `fail` at once, popup open or not, and leaves the waiter
 * armed for a retry; only a success waits on the popup.
 */
export function routeCompletion(
  d: IntegrationConnectCompletion,
  waiter: ConnectWaiter,
  fail: (error?: string) => void,
): void {
  if (d.ok === false) fail(d.error);
  else waiter.connected();
}
