// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";

/** The scopes a server asked for that the connection does not hold; nothing when there are none. */
export function ConnectionRequestedScopesBadge({ scopes }: { scopes: readonly string[] }) {
  const { t } = useTranslation("settings");
  if (scopes.length === 0) return null;
  const label = t("integration.connection.requestedScopes", { scopes: scopes.join(", ") });
  return (
    <Badge variant="warning" className="max-w-full min-w-0" title={label}>
      <span className="truncate">{label}</span>
    </Badge>
  );
}

/** `needsReconnection` is a RECOVERABLE warning (the owner can renew): amber, never red. */
export function ConnectionStatusBadge({ needsReconnection }: { needsReconnection: boolean }) {
  const { t } = useTranslation("settings");
  return needsReconnection ? (
    <Badge variant="warning">{t("integration.auth.needsReconnection")}</Badge>
  ) : (
    <Badge variant="success">{t("integration.connection.statusConnected")}</Badge>
  );
}
