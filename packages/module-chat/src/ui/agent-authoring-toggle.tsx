// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's agent-authoring toggle: lets the caller keep the assistant to
 * published agents instead of creating new ones or composing one on the fly.
 *
 * A PREFERENCE inside the `agents:write` grant: the host renders it only for a
 * caller who may create agents. The chat sends it with every turn
 * (`agent_authoring`) and the server intersects it with the grant: it narrows
 * the turn's authority and can never widen it.
 */

import { BotIcon, BotOffIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { setAgentAuthoringEnabled, useAgentAuthoringEnabled } from "./agent-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";

export function AgentAuthoringToggle() {
  const { t } = useChatHost();
  const enabled = useAgentAuthoringEnabled();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={enabled}
            aria-label={t("agentAuthoring.label")}
            onClick={() => setAgentAuthoringEnabled(!enabled)}
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
            {t(enabled ? "agentAuthoring.onTitle" : "agentAuthoring.offTitle")}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {t(enabled ? "agentAuthoring.onHint" : "agentAuthoring.offHint")}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
