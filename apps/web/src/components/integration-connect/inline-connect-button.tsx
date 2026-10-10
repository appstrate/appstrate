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
  iconOnly = false,
}: {
  packageId: string;
  authKey: string;
  connectionId: string;
  /** Compact row-action trigger; the label remains available to assistive tech. */
  iconOnly?: boolean;
}) {
  const { t } = useTranslation("agents");
  const { openPopup, isPending } = useHostedConnectPopup();
  const label = t("detail.integrationReconnect");
  return (
    <Button
      size={iconOnly ? "icon" : "sm"}
      variant={iconOnly ? "ghost" : "default"}
      className={iconOnly ? "size-7" : undefined}
      // openPopup never rejects: every failure path toasts and resolves.
      onClick={() => void openPopup({ packageId, authKey, connectionId })}
      disabled={isPending}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      data-testid={`inline-connect-${packageId}-${authKey}`}
    >
      <RefreshCw className={iconOnly ? "size-3.5" : "mr-1 size-3"} />
      {!iconOnly && label}
    </Button>
  );
}
