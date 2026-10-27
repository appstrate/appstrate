// SPDX-License-Identifier: Apache-2.0

// Browser-side twin of the OAuth callback page's inline script (`apps/api/src/lib/oauth-popup-html.ts`):
// both read names, payload and origin policy from `@appstrate/core/connect-handshake`.

import {
  INTEGRATION_CONNECT_CHANNEL,
  buildIntegrationConnectCompletion,
  integrationConnectOrigin,
} from "@appstrate/core/connect-handshake";

/** Both carriers are best-effort; the waiting surface still has its SSE `connection_update` backstop. */
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
