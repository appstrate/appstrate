// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { discoveryErrorKey, type DiscoveryState } from "@/lib/model-discovery";

/** What a detection answered: how many models it listed, or why it listed none. */
export function DiscoveryResult({ discovery }: { discovery: DiscoveryState }) {
  const { t } = useTranslation("settings");
  if (discovery.outcome !== "ok") {
    return (
      <div className="text-destructive text-sm">{t(discoveryErrorKey(discovery.outcome))}</div>
    );
  }
  return (
    <div className="text-muted-foreground text-sm">
      {discovery.models.length > 0
        ? t("models.form.discoverCount", { count: discovery.models.length })
        : t("models.form.discoverEmpty")}
      {/* A capped listing is short of what the endpoint serves: « these are the first models ». */}
      {discovery.truncated && <span className="block">{t("models.form.discoverTruncated")}</span>}
    </div>
  );
}
