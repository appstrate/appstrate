// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

/**
 * The provenance badge shared by every system+DB table (integration OAuth
 * clients, models, model-provider credentials, proxies): `built-in` (a
 * platform/env entry, read-only), `auto-provisioned` (a DCR/CIMD machine
 * client, read-only) or `custom` (the org's own row). One component so the
 * wording + variant never drift across surfaces.
 */
export function SourceBadge({
  source,
  autoProvisioned = false,
}: {
  source: "built-in" | "custom";
  autoProvisioned?: boolean;
}) {
  const { t } = useTranslation("settings");
  if (source === "built-in") {
    return <Badge variant="secondary">{t("source.builtIn")}</Badge>;
  }
  if (autoProvisioned) {
    return <Badge variant="outline">{t("source.autoProvisioned")}</Badge>;
  }
  return <Badge variant="outline">{t("source.custom")}</Badge>;
}
