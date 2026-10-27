// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { useTranslation } from "react-i18next";
import { ClockIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { mimeIconFor, fileExpiryInfo } from "../lib/files";

/**
 * Relative-expiry badge, the one label every file surface shows for a retention
 * deadline (tile, table column, artifact header). Warning-toned inside the
 * 7-day window (or already past), muted otherwise. Sub-day deadlines read in
 * hours, everything else in whole days.
 */
export function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation("files");
  const info = fileExpiryInfo(expiresAt);
  if (!info) return null;
  const label = info.expired
    ? t("expiry.expired")
    : info.days >= 1
      ? t("expiry.inDays", { count: info.days })
      : t("expiry.inHours", { count: info.hours });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        info.soon ? "text-warning" : "text-muted-foreground",
      )}
      title={label}
    >
      <ClockIcon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Render the mime's Lucide icon. `createElement` (not a PascalCase const from
 * the helper) keeps `react-hooks/static-components` happy — the rule flags a
 * component derived from a helper call during render.
 */
export function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  return createElement(mimeIconFor(mime), { className });
}
