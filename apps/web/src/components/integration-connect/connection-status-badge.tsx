// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";

/**
 * Connection-state pill shared across every surface that flags a connection's
 * health — the member connections page and the integration detail page (the
 * Connexions picker keeps its own dropdown-row affordances). Owns both the
 * label and the color: `needsReconnection` is a RECOVERABLE warning (the owner
 * can renew), so it reads amber, never red, on every surface.
 */
export function ConnectionStatusBadge({ needsReconnection }: { needsReconnection: boolean }) {
  const { t } = useTranslation("settings");
  return needsReconnection ? (
    <Badge variant="warning">{t("integration.auth.needsReconnection")}</Badge>
  ) : (
    <Badge variant="success">{t("integration.connection.statusConnected")}</Badge>
  );
}
