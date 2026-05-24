// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useInitiateIntegrationOAuth } from "../../hooks/use-integrations";
import { useOAuthPopup } from "../../hooks/use-oauth-popup";

/**
 * Integration-side wrapper around the generic OAuth popup driver
 * (`useOAuthPopup`).
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
  const openOAuthPopup = useOAuthPopup("integration-oauth");

  const openPopup = useCallback(
    async (input: {
      packageId: string;
      authKey: string;
      scopes?: string[];
      forceAccountSelect?: boolean;
      connectionId?: string;
    }) => {
      try {
        await openOAuthPopup(() =>
          initiateOAuth.mutateAsync({
            packageId: input.packageId,
            authKey: input.authKey,
            ...(input.scopes ? { scopes: input.scopes } : {}),
            ...(input.forceAccountSelect ? { forceAccountSelect: true } : {}),
            ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          }),
        );
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
    [initiateOAuth, openOAuthPopup, qc, t],
  );

  return { openPopup, isPending: initiateOAuth.isPending };
}
