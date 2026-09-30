// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";

/**
 * The provenance badge shared by every system+DB table: models, model-provider
 * credentials and proxies say `built-in` / `custom` (the org's own row);
 * integration OAuth clients name their owning tier, `system` / `org` / `space`.
 * `auto-provisioned` marks a DCR/CIMD machine client, read-only. One component
 * so the wording + variant never drift.
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
