// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";

/**
 * The provenance badge shared by every system+DB table (integration OAuth
 * clients, models, model-provider credentials, proxies): `built-in` (a
 * platform/env entry, read-only), `auto-provisioned` (a DCR/CIMD machine
 * client, read-only), `org` (inherited from the organization) or `custom` (the
 * owner's own row). One component so the wording + variant never drift.
 */
export function SourceBadge({
  source,
  autoProvisioned = false,
  customLabel = "custom",
}: {
  source: "built-in" | "org" | "custom";
  autoProvisioned?: boolean;
  /** How an owner's own row reads: `custom`, or `space` where org rows sit beside it. */
  customLabel?: "custom" | "space";
}) {
  const { t } = useTranslation("settings");
  if (source === "built-in") {
    return <Badge variant="secondary">{t("source.builtIn")}</Badge>;
  }
  if (source === "org") {
    return <Badge variant="secondary">{t("source.org")}</Badge>;
  }
  if (autoProvisioned) {
    return <Badge variant="outline">{t("source.autoProvisioned")}</Badge>;
  }
  return (
    <Badge variant="outline">{t(customLabel === "space" ? "source.space" : "source.custom")}</Badge>
  );
}
