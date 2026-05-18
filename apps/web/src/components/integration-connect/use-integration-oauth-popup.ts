// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useInitiateIntegrationOAuth } from "../../hooks/use-integrations";

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60_000;

/**
 * Shared OAuth-popup driver for integration connect/upgrade flows.
 *
 * Originally inlined in `pages/integration-detail.tsx`. Lifted so the
 * agent-side connect surfaces (`AgentIntegrationsBlock`,
 * `MissingConnectionsModal`) can trigger the same flow without
 * navigating away — connections are conceptually owned by the
 * (integration, auth, account, actor) tuple but the *trigger* is
 * agent-driven (scope union depends on which agent's tools[] the
 * actor is about to run).
 *
 * `scopes` is passed through to `/api/integrations/.../connect/oauth2`
 * so the kickoff requests exactly the union the agent needs. The
 * backend resolver still unions with current granted + computed-across-
 * agents for incremental consent.
 */
export function useIntegrationOAuthPopup() {
  const { t } = useTranslation("settings");
  const initiateOAuth = useInitiateIntegrationOAuth();

  const openPopup = useCallback(
    async (input: { packageId: string; authKey: string; scopes?: string[] }) => {
      const popup = window.open("", "integration-oauth", "width=600,height=700");
      if (!popup) {
        window.alert(t("integration.popup.blocked"));
        return;
      }
      try {
        const session = await initiateOAuth.mutateAsync({
          packageId: input.packageId,
          authKey: input.authKey,
          ...(input.scopes ? { scopes: input.scopes } : {}),
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
            reject(new Error("OAuth timeout"));
          }, OAUTH_POPUP_TIMEOUT_MS);
          const poll = setInterval(() => {
            if (popup.closed) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve();
            }
          }, 500);
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
    [initiateOAuth, t],
  );

  return { openPopup, isPending: initiateOAuth.isPending };
}
