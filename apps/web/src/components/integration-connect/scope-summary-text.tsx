// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { ScopeSummary } from "./connection-scope-fit";

/** A connection's granted permissions in one line; "default permissions" only when it holds them all. */
export function ScopeSummaryText({
  summary,
  title,
  className,
}: {
  summary: ScopeSummary;
  title: string;
  className: string;
}) {
  const { t } = useTranslation("settings");
  const parts = [
    summary.text,
    summary.lacking && t("integration.connection.lackingDefaults", { scopes: summary.lacking }),
  ].filter(Boolean);
  return (
    <span className={className} title={title}>
      {parts.length > 0 ? parts.join(" · ") : t("integration.connection.defaultPermissions")}
    </span>
  );
}
