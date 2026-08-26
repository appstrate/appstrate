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
 * Post the completion to `opener` (scoped to `selfOrigin`) and publish it on
 * the shared `BroadcastChannel`. Both carriers are best-effort — an opener that
 * has navigated away and a browser without `BroadcastChannel` are ordinary, and
 * the waiting surface still has its SSE `connection_update` backstop.
 */
export function publishConnectCompletion(
  detail: { ok: boolean; state?: string; packageId?: string; error?: string },
  opener: Window | null,
  selfOrigin: string,
): void {
  const message = buildIntegrationConnectCompletion(detail);
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
