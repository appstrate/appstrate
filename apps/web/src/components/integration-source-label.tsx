// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { IntegrationSource } from "../lib/integration-collection";
import { useAppConfig } from "../hooks/use-app-config";

/**
 * Where an integration's tools come from, worded once for every surface (table cell, card, sheet,
 * detail): its API, a hosted MCP server, or an MCP server run in the sandbox. The last says so
 * when this instance cannot run local servers; the hint is a focusable trigger, its explanation
 * also screen-reader text.
 */
export function IntegrationSourceLabel({
  source,
  stacked = false,
  className,
}: {
  source: IntegrationSource;
  /** The reservation on its own line under the label (a table cell) instead of beside it. */
  stacked?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <span
      className={cn(
        "flex min-w-0 gap-x-1.5",
        stacked ? "flex-col items-start [&>*]:max-w-full" : "flex-wrap items-baseline",
        className,
      )}
    >
      <span className="truncate">{t(`integrations.source.${source}`)}</span>
      {source === "local" && <LocalUnavailableHint />}
    </span>
  );
}

/**
 * « indisponible ici »: this instance cannot run local servers. A focusable trigger, its
 * explanation also screen-reader text. Nothing when it can.
 */
export function LocalUnavailableHint() {
  const { t } = useTranslation("settings");
  const { localIntegrations } = useAppConfig().features;
  if (localIntegrations) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Raised above a row's link overlay, or the row swallows the hover. */}
        <span
          tabIndex={0}
          className="text-muted-foreground/70 relative z-10 truncate text-[0.68rem]"
        >
          {t("integrations.source.localUnavailable")}
          <span className="sr-only">{t("integrations.source.localUnavailableHint")}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {t("integrations.source.localUnavailableHint")}
      </TooltipContent>
    </Tooltip>
  );
}
