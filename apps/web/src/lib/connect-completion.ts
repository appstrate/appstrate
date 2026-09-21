// SPDX-License-Identifier: Apache-2.0

/**
 * Announce a finished integration-connect to whatever surface is waiting.
 *
 * The browser-side twin of the OAuth callback page's inline script
 * (`apps/api/src/lib/oauth-popup-html.ts`): the hosted credential form ends the
 * non-OAuth half of the same flow and must produce the same two signals, so
 * both halves read their names, payload and origin policy from
 * `@appstrate/core/connect-handshake`.
 *
 * Kept out of the page component so the handshake it emits is testable without
 * a DOM: the caller supplies the opener and its own origin.
 */

import {
  INTEGRATION_CONNECT_CHANNEL,
  buildIntegrationConnectCompletion,
  integrationConnectOrigin,
} from "@appstrate/core/connect-handshake";

/**
 * Post `message` to `opener` (scoped to `selfOrigin`) and publish it on the
 * shared `BroadcastChannel`. Both carriers are best-effort — an opener that has
 * navigated away and a browser without `BroadcastChannel` are ordinary, and the
 * waiting surface still has its SSE `connection_update` backstop.
 */
function publish(message: object, opener: Window | null, selfOrigin: string): void {
  try {
    opener?.postMessage(message, integrationConnectOrigin(selfOrigin));
  } catch {
    /* opener gone — fall through to the channel */
  }
  try {
    const bc = new BroadcastChannel(INTEGRATION_CONNECT_CHANNEL);
    bc.postMessage(message);
    bc.close();
  } catch {
    /* BroadcastChannel unsupported — the SSE backstop still fires server-side */
  }
}

/** Announce that the connect flow is over, successfully or not. */
export function publishConnectCompletion(
  detail: { ok: boolean; state?: string; packageId?: string; error?: string },
  opener: Window | null,
  selfOrigin: string,
): void {
  publish(buildIntegrationConnectCompletion(detail), opener, selfOrigin);
}

/**
 * `type` discriminator of the held-open signal. Deliberately NOT the
 * completion's: every surface waiting for a connect correlates on that one and
 * therefore ignores this message, which is what keeps it from settling
 * anything.
 */
const HELD_OPEN_MESSAGE_TYPE = "appstrate:integration_connect_held_open";

/**
 * "The connection exists; this window is staying open on purpose."
 *
 * Read off the wire, so every field is optional — the shape is what a sender
 * promises, never what a receiver may assume.
 */
interface ConnectHeldOpen {
  type?: string;
  /** `@scope/name` of the integration — the only correlation this kind has. */
  packageId?: string;
}

/** Mint a held-open payload with its discriminator applied. */
function buildConnectHeldOpen(detail: { packageId: string }): ConnectHeldOpen {
  return { type: HELD_OPEN_MESSAGE_TYPE, ...detail };
}

/**
 * Announce that the connection was created but this window is not done: it is
 * showing an install block the user has to run on another machine, which
 * outlives any deadline the opener could reasonably pick. The completion itself
 * follows later, on the user's own "I ran it".
 */
export function publishConnectHeldOpen(
  detail: { packageId: string },
  opener: Window | null,
  selfOrigin: string,
): void {
  publish(buildConnectHeldOpen(detail), opener, selfOrigin);
}

/**
 * Whether `data` is a held-open signal addressed to `target`.
 *
 * It fails CLOSED on the package: both carriers fan out, and a signal that
 * names another integration must not disarm a deadline this one is counting on.
 * Unlike a completion there is no second identifier to fall back on, so the
 * rule is the one comparison.
 */
export function connectHeldOpenMatches(data: unknown, target: { packageId: string }): boolean {
  if (typeof data !== "object" || data === null) return false;
  const held = data as ConnectHeldOpen;
  return held.type === HELD_OPEN_MESSAGE_TYPE && held.packageId === target.packageId;
}

/**
 * Whether a `message` event may be acted on as a held-open signal for
 * `target` — origin first, then the correlation, exactly as
 * `acceptsCompletionMessage` orders them. Core's `isIntegrationConnectMessage`
 * validates the completion type and so cannot serve this kind; the policy it
 * applies is reproduced here: the receiving page's own origin, and never an
 * opaque one, which identifies nobody and is what every sandboxed sender
 * reports.
 */
export function acceptsConnectHeldOpenMessage(
  event: { origin: string; data: unknown },
  selfOrigin: string,
  target: { packageId: string },
): boolean {
  let self: string;
  try {
    self = integrationConnectOrigin(selfOrigin);
  } catch {
    // An unparseable origin — trust nothing rather than throw out of a
    // `message` listener.
    return false;
  }
  if (self === "null" || event.origin !== self) return false;
  return connectHeldOpenMatches(event.data, target);
}
