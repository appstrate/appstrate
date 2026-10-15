// SPDX-License-Identifier: Apache-2.0

import { ToneBadge } from "@/components/app-ui/status-variants";
import { useTranslation } from "react-i18next";

/** `needsReconnection` is a RECOVERABLE warning (the owner can renew): amber, never red. */
export function ConnectionStatusBadge({ needsReconnection }: { needsReconnection: boolean }) {
  const { t } = useTranslation("settings");
  return needsReconnection ? (
    <ToneBadge variant="warning">{t("integration.auth.needsReconnection")}</ToneBadge>
  ) : (
    <ToneBadge variant="success">{t("integration.connection.statusConnected")}</ToneBadge>
  );
}
