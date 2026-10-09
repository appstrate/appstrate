// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useHostedConnectPopup } from "./use-integration-oauth-popup";

/**
 * Reconnects one connection in place through the hosted connect portal (issue #769), so the
 * credential secret never touches this bundle. It requests no scopes: the server re-consents
 * what the row holds, which widens no agent bound to it.
 */
export function InlineConnectButton({
  packageId,
  authKey,
  connectionId,
}: {
  packageId: string;
  authKey: string;
  connectionId: string;
}) {
  const { t } = useTranslation("agents");
  const { openPopup, isPending } = useHostedConnectPopup();
  return (
    <Button
      size="sm"
      // openPopup never rejects: every failure path toasts and resolves.
      onClick={() => void openPopup({ packageId, authKey, connectionId })}
      disabled={isPending}
      data-testid={`inline-connect-${packageId}-${authKey}`}
    >
      <RefreshCw className="mr-1 size-3" />
      {t("detail.integrationReconnect")}
    </Button>
  );
}
