// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";

/**
 * The provenance badge of every system+DB table: `built-in` / `custom`, or an OAuth
 * client's owning tier (`system` / `org` / `space`); `auto-provisioned` = a read-only
 * DCR/CIMD client.
 */
export function SourceBadge({
  source,
  autoProvisioned = false,
}: {
  source: "built-in" | "custom" | "system" | "org" | "space";
  autoProvisioned?: boolean;
}) {
  const { t } = useTranslation("settings");
  if (source === "built-in" || source === "system") {
    return <Badge variant="secondary">{t("source.builtIn")}</Badge>;
  }
  if (source === "org") {
    return <Badge variant="secondary">{t("source.org")}</Badge>;
  }
  if (autoProvisioned) {
    return <Badge variant="outline">{t("source.autoProvisioned")}</Badge>;
  }
  return (
    <Badge variant="outline">{t(source === "space" ? "source.space" : "source.custom")}</Badge>
  );
}
