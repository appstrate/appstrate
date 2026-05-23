// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60_000;
const POPUP_POLL_INTERVAL_MS = 500;
const POPUP_FEATURES = "width=600,height=700";

export interface OAuthPopupHandle {
  authUrl: string;
}

/**
 * Generic driver for the OAuth-via-popup flow. Its only consumer is
 * `useIntegrationOAuthPopup` (integration connections); it stays a separate
 * generic hook so the popup-blocker handling, the 5-min timeout, and the
 * `popup.closed` poll cadence live in one place.
 *
 * Open the popup synchronously (some browsers block popups opened
 * inside async callbacks), fetch the authUrl via the caller-supplied
 * `getAuthUrl`, point the popup at it, then race a timeout against the
 * user closing the window. The promise resolves when the popup closes
 * (success or user cancel — the caller can't distinguish) and rejects
 * on timeout or `getAuthUrl` throw.
 */
export function useOAuthPopup(name: string) {
  return useCallback(
    async (getAuthUrl: () => Promise<OAuthPopupHandle>): Promise<void> => {
      const popup = window.open("", name, POPUP_FEATURES);
      if (!popup) {
        throw new Error("popup_blocked");
      }
      try {
        const session = await getAuthUrl();
        popup.location.href = session.authUrl;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            clearInterval(poll);
            try {
              popup.close();
            } catch {
              /* ignore */
            }
            reject(new Error("oauth_timeout"));
          }, OAUTH_POPUP_TIMEOUT_MS);
          const poll = setInterval(() => {
            if (popup.closed) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve();
            }
          }, POPUP_POLL_INTERVAL_MS);
        });
      } catch (err) {
        try {
          popup.close();
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    [name],
  );
}
