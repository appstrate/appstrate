// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";

/** `needsReconnection` is a RECOVERABLE warning (the owner can renew): amber, never red. */
export function ConnectionStatusBadge({ needsReconnection }: { needsReconnection: boolean }) {
  const { t } = useTranslation("settings");
  return needsReconnection ? (
    <Badge variant="warning">{t("integration.auth.needsReconnection")}</Badge>
  ) : (
    <Badge variant="success">{t("integration.connection.statusConnected")}</Badge>
  );
}
