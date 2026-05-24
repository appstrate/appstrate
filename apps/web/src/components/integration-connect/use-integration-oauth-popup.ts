// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useInitiateIntegrationOAuth } from "../../hooks/use-integrations";

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60_000;
const POPUP_POLL_INTERVAL_MS = 500;
const POPUP_FEATURES = "width=600,height=700";

/**
 * Drives the integration OAuth-via-popup flow.
 *
 * Wired against `/api/integrations/.../connect/oauth2` so the
 * inline connect button on agent surfaces (`AgentIntegrationsBlock`,
 * `MissingConnectionsModal`) can pass the agent's per-tool scope
 * inference into the kickoff. On a reconnect/upgrade (a `connectionId`
 * is supplied) the backend unions the caller scopes with that
 * connection's already-granted set, so re-consent never shrinks the
 * grant. A fresh connect carries no `connectionId` and gets the
 * manifest defaults plus whatever scopes the caller forwards.
 */
export function useIntegrationOAuthPopup() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const initiateOAuth = useInitiateIntegrationOAuth();

  const openPopup = useCallback(
    async (input: {
      packageId: string;
      authKey: string;
      scopes?: string[];
      forceAccountSelect?: boolean;
      connectionId?: string;
    }) => {
      try {
        // Open the popup synchronously (some browsers block popups opened
        // inside async callbacks), fetch the authUrl, point the popup at it,
        // then race a 5-min timeout against the user closing the window. The
        // promise resolves when the popup closes (success or user cancel — we
        // can't distinguish) and rejects on timeout or kickoff failure. On a
        // reconnect/upgrade (a `connectionId` is supplied) the backend unions
        // the caller scopes with that connection's already-granted set, so
        // re-consent never shrinks the grant.
        const popup = window.open("", "integration-oauth", POPUP_FEATURES);
        if (!popup) {
          throw new Error("popup_blocked");
        }
        try {
          const session = await initiateOAuth.mutateAsync({
            packageId: input.packageId,
            authKey: input.authKey,
            ...(input.scopes ? { scopes: input.scopes } : {}),
            ...(input.forceAccountSelect ? { forceAccountSelect: true } : {}),
            ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          });
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
        // The popup resolves only on a successful connect. Invalidate the
        // integration + user-connection caches so every consumer (status
        // cards, pickers, the connectors page) reflects the new connection
        // without waiting for a window-focus refetch. `useInitiateIntegrationOAuth`
        // only kicks off the redirect — the connection is created in the popup.
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["integrations"] }),
          qc.invalidateQueries({ queryKey: ["me-connections"] }),
        ]);
      } catch (err) {
        if (err instanceof Error && err.message === "popup_blocked") {
          window.alert(t("integration.popup.blocked"));
          return;
        }
        throw err;
      }
    },
    [initiateOAuth, qc, t],
  );

  return { openPopup, isPending: initiateOAuth.isPending };
}
