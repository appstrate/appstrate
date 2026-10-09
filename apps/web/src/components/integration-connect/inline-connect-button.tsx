// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plug, RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useHostedConnectPopup } from "./use-integration-oauth-popup";

/**
 * The integration page's connect and reconnect trigger, bound to one auth: the per-auth
 * "+ Ajouter" (ConnectAuthBlock) and the per-row reconnect (ConnectionsTable).
 *
 * Every auth type goes through the hosted connect portal (issue #769): `openPopup` mints a
 * connect session whose `connect_url` dispatches server-side to the provider OAuth screen or
 * the hosted credential form, so the credential secret never touches this bundle. It requests
 * no scopes: a connect gets the auth's `default_scopes`, a reconnect re-consents what the row
 * holds. The popup invalidates the integration queries once it settles.
 */
export function InlineConnectButton({
  packageId,
  authKey,
  intent,
  size = "sm",
  label,
  forceAccountSelect,
  connectionId,
}: {
  packageId: string;
  authKey: string;
  /** `reconnect` re-runs the connect flow on the row named by `connectionId`, updated in place. */
  intent: "connect" | "reconnect";
  size?: "sm" | "default";
  /** Overrides the button label. */
  label?: string;
  /** Forces the IdP's account picker (`prompt=select_account`), so a second connect can pick another account. */
  forceAccountSelect?: boolean;
  /** The connection to update in place; without it the connect creates a new one. */
  connectionId?: string;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { openPopup, isPending } = useHostedConnectPopup();
  const Icon = intent === "connect" ? Plug : RefreshCw;

  return (
    <Button
      size={size}
      // openPopup never rejects: every failure path toasts and resolves.
      onClick={() =>
        void openPopup({
          packageId,
          authKey,
          ...(forceAccountSelect ? { forceAccountSelect: true } : {}),
          ...(connectionId ? { connectionId } : {}),
        })
      }
      disabled={isPending}
      data-testid={`inline-connect-${packageId}-${authKey}`}
    >
      <Icon className="mr-1 size-3" />
      {label ??
        (intent === "reconnect"
          ? t("detail.integrationReconnect")
          : t("detail.integrationConnect"))}
    </Button>
  );
}
