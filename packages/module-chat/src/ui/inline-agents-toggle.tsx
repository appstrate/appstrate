// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's inline-agents toggle: lets the caller keep the assistant to
 * existing agents instead of composing one on the fly.
 *
 * A PREFERENCE inside the `agents:run-inline` grant, so it is hidden outright
 * for a caller without it — a toggle for a capability the platform refuses is
 * a lie discoverable only by trying. The chat sends it with every turn
 * (`inline_agents`) and the server intersects it with the grant: it narrows
 * the turn's authority and can never widen it. Global and persisted, which is
 * why its off state has a look of its own rather than a checkbox buried in a
 * popover.
 */

import { useSyncExternalStore } from "react";
import { BotIcon, BotOffIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import {
  getInlineAgentsEnabled,
  setInlineAgentsEnabled,
  subscribeInlineAgents,
} from "./model-store.ts";
import { useChatHost } from "./runtime-context.ts";

export function InlineAgentsToggle() {
  const { t, canRunInline } = useChatHost();
  const enabled = useSyncExternalStore(subscribeInlineAgents, getInlineAgentsEnabled, () => true);
  if (!canRunInline) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={enabled}
            aria-label={t("inlineAgents.label")}
            onClick={() => setInlineAgentsEnabled(!enabled)}
            className={cn(
              "size-8 shrink-0 rounded-lg",
              enabled ? "text-primary hover:text-primary" : "text-muted-foreground",
            )}
          >
            {enabled ? <BotIcon /> : <BotOffIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-xs">
          <p className="font-medium">
            {t(enabled ? "inlineAgents.onTitle" : "inlineAgents.offTitle")}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {t(enabled ? "inlineAgents.onHint" : "inlineAgents.offHint")}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
