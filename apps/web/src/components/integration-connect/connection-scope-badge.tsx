// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { ConnectionScope } from "@appstrate/shared-types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";

/** Where a connection is usable — fixed by the OAuth client that minted it — with the why on hover. */
export function ConnectionScopeBadge({
  scope,
  testId,
}: {
  scope: ConnectionScope;
  testId?: string;
}) {
  const { t } = useTranslation("settings");
  const label =
    scope === "org"
      ? t("integration.connection.scope.org")
      : t("integration.connection.scope.space");
  const help =
    scope === "org"
      ? t("integration.connection.scope.orgHelp")
      : t("integration.connection.scope.spaceHelp");
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="text-muted-foreground border-border inline-flex shrink-0 cursor-default rounded-full border px-2 py-px text-[0.65rem] whitespace-nowrap"
            data-testid={testId}
          >
            {label}
            <span className="sr-only">{help}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{help}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
