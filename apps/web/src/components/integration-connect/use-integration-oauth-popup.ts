// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInitiateIntegrationOAuth } from "../../hooks/use-integrations";
import { useOAuthPopup } from "../../hooks/use-oauth-popup";

/**
 * Integration-side wrapper around the generic OAuth popup driver.
 *
 * Same flow used by the legacy provider connect path (`useConnectOAuth`)
 * — wired here against `/api/integrations/.../connect/oauth2` so the
 * inline connect button on agent surfaces (`AgentIntegrationsBlock`,
 * `MissingConnectionsModal`) can pass the agent's per-tool scope
 * inference into the kickoff. The backend resolver still unions the
 * caller scopes with `getCurrentGrantedScopes(actor)` for incremental
 * consent, so re-running with fewer scopes never shrinks the grant.
 */
export function useIntegrationOAuthPopup() {
  const { t } = useTranslation("settings");
  const initiateOAuth = useInitiateIntegrationOAuth();
  const openOAuthPopup = useOAuthPopup("integration-oauth");

  const openPopup = useCallback(
    async (input: { packageId: string; authKey: string; scopes?: string[] }) => {
      try {
        await openOAuthPopup(() =>
          initiateOAuth.mutateAsync({
            packageId: input.packageId,
            authKey: input.authKey,
            ...(input.scopes ? { scopes: input.scopes } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.message === "popup_blocked") {
          window.alert(t("integration.popup.blocked"));
          return;
        }
        throw err;
      }
    },
    [initiateOAuth, openOAuthPopup, t],
  );

  return { openPopup, isPending: initiateOAuth.isPending };
}
