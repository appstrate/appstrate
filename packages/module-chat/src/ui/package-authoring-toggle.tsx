// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's package-authoring toggle: lets the caller keep the assistant to
 * what exists (published agents, the space's skills and integrations) instead of
 * creating packages or composing an agent on the fly.
 *
 * A PREFERENCE inside the package write grants: the host renders it only for a
 * caller who may create a package of some type. The chat sends it with every turn
 * (`package_authoring`) and the server intersects it with the grant: it narrows
 * the turn's authority and can never widen it.
 */

import { PackageIcon, PackageXIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import {
  setPackageAuthoringEnabled,
  usePackageAuthoringEnabled,
} from "./package-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";

export function PackageAuthoringToggle() {
  const { t } = useChatHost();
  const enabled = usePackageAuthoringEnabled();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-pressed={enabled}
          aria-label={t("packageAuthoring.label")}
          onClick={() => setPackageAuthoringEnabled(!enabled)}
          className={cn(
            "size-8 shrink-0 rounded-lg",
            enabled ? "text-primary hover:text-primary" : "text-muted-foreground",
          )}
        >
          {enabled ? <PackageIcon /> : <PackageXIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <p className="font-medium">
          {t(enabled ? "packageAuthoring.onTitle" : "packageAuthoring.offTitle")}
        </p>
        <p className="text-muted-foreground mt-0.5">
          {t(enabled ? "packageAuthoring.onHint" : "packageAuthoring.offHint")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
