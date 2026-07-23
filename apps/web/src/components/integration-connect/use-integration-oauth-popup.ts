// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  invalidateIntegrationQueries,
  useInitiateIntegrationConnect,
} from "../../hooks/use-integrations";

const CONNECT_POPUP_TIMEOUT_MS = 5 * 60_000;
const POPUP_POLL_INTERVAL_MS = 500;
const POPUP_FEATURES = "width=600,height=700";

// Must match `apps/api/src/lib/oauth-popup-html.ts` + the hosted form
// (`pages/hosted-connect.tsx`) — both emit this on a successful connect.
const INTEGRATION_BROADCAST_CHANNEL = "appstrate_integration";
const INTEGRATION_MESSAGE_TYPE = "appstrate:integration_connection";

/**
 * Drives the unified hosted-connect-portal flow via popup (issue #769).
 *
 * Auth-type-agnostic: mints a connect session (`/connect/session`) and opens the
 * returned `connect_url`, which dispatches server-side to the provider OAuth
 * screen (oauth2) or the hosted credential form (api_key/basic/mtls/custom). The
 * caller therefore never branches on the auth type — one entry point for every
 * integration.
 *
 * On a reconnect/upgrade (a `connectionId` is supplied) the backend unions the
 * caller scopes with that connection's already-granted set, so re-consent never
 * shrinks the grant. A fresh connect carries no `connectionId` and gets the
 * manifest defaults plus whatever scopes the caller forwards.
 *
 * Completion is event-driven: both the OAuth callback page and the hosted form
 * broadcast `appstrate:integration_connection` on success (postMessage +
 * BroadcastChannel). The promise resolves on that signal OR when the popup
 * closes (cancel fallback) and rejects on timeout / kickoff failure.
 */
export function useHostedConnectPopup() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const initiateConnect = useInitiateIntegrationConnect();

  const openPopup = useCallback(
    async (input: {
      packageId: string;
      authKey: string;
      scopes?: string[];
      forceAccountSelect?: boolean;
      connectionId?: string;
    }) => {
      try {
        // Open the popup synchronously (some browsers block popups opened inside
        // async callbacks), mint the session, point the popup at connect_url,
        // then race a 5-min timeout against a success signal or the user closing
        // the window.
        const popup = window.open("", "integration-connect", POPUP_FEATURES);
        if (!popup) {
          throw new Error("popup_blocked");
        }
        try {
          const session = await initiateConnect.mutateAsync({
            params: { path: { packageId: input.packageId, authKey: input.authKey } },
            body: {
              scopes: input.scopes ?? [],
              ...(input.forceAccountSelect ? { force_account_select: true } : {}),
              ...(input.connectionId ? { connection_id: input.connectionId } : {}),
            },
          });
          popup.location.href = session.connect_url;
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              clearInterval(poll);
              clearTimeout(timer);
              window.removeEventListener("message", onMessage);
              bc?.close();
            };
            const onHit = () => {
              cleanup();
              try {
                popup.close();
              } catch {
                /* ignore */
              }
              resolve();
            };
            const isSignal = (data: unknown): boolean =>
              !!data &&
              typeof data === "object" &&
              (data as { type?: string }).type === INTEGRATION_MESSAGE_TYPE &&
              (data as { ok?: boolean }).ok === true;
            const onMessage = (e: MessageEvent) => {
              // The success page (hosted form + OAuth popup HTML) is served from
              // our own origin, so reject foreign-origin messages — a forged
              // signal from another tab must not stand in for a real connect.
              if (e.origin !== window.location.origin) return;
              if (isSignal(e.data)) onHit();
            };
            window.addEventListener("message", onMessage);
            let bc: BroadcastChannel | null = null;
            try {
              bc = new BroadcastChannel(INTEGRATION_BROADCAST_CHANNEL);
              bc.onmessage = (e) => {
                if (isSignal(e.data)) onHit();
              };
            } catch {
              /* BroadcastChannel unsupported — postMessage + close-poll cover it */
            }
            const timer = setTimeout(() => {
              cleanup();
              try {
                popup.close();
              } catch {
                /* ignore */
              }
              reject(new Error("connect_timeout"));
            }, CONNECT_POPUP_TIMEOUT_MS);
            // Close-without-signal = user cancel; resolve so consumers re-read
            // the truth (the cache invalidation below is a no-op if nothing
            // changed).
            const poll = setInterval(() => {
              if (popup.closed) {
                cleanup();
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
        // Invalidate the integration + user-connection caches so every consumer
        // (status cards, pickers, the connections page) reflects the new
        // connection without waiting for a window-focus refetch.
        await Promise.all([
          invalidateIntegrationQueries(qc),
          qc.invalidateQueries({ queryKey: ["get", "/api/me/connections"] }),
        ]);
      } catch (err) {
        if (err instanceof Error && err.message === "popup_blocked") {
          toast.error(t("integration.popup.blocked"));
          return;
        }
        if (err instanceof Error && err.message === "connect_timeout") {
          toast.error(t("integration.popup.timeout"));
          return;
        }
        // Mint failure (e.g. portal not configured / 5xx), network error, or any
        // other unexpected throw: surface a generic toast here so callers never
        // have to handle a rejected openPopup() — the cache stays untouched.
        toast.error(t("integration.popup.failed"));
      }
    },
    [initiateConnect, qc, t],
  );

  return { openPopup, isPending: initiateConnect.isPending };
}
