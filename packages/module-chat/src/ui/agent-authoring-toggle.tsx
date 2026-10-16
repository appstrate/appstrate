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

import { useState } from "react";
import { Switch } from "@appstrate/ui/components/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@appstrate/ui/components/popover";
import { BotIcon, BotOffIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { setAgentAuthoringEnabled, useAgentAuthoringEnabled } from "./agent-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";

export function AgentAuthoringToggle() {
  const { t } = useChatHost();
  const enabled = useAgentAuthoringEnabled();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<boolean | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setDraft(null);
        setOpen(next);
      }}
    >
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={enabled}
              aria-label={t("agentAuthoring.label")}
              className={cn(
                "size-8 shrink-0 rounded-lg",
                enabled ? "text-primary hover:text-primary" : "text-muted-foreground",
              )}
            >
              {enabled ? <BotIcon /> : <BotOffIcon />}
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="top" className="max-w-72 text-xs">
          <p className="font-medium">
            {t(enabled ? "agentAuthoring.onTitle" : "agentAuthoring.offTitle")}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {t(enabled ? "agentAuthoring.onHint" : "agentAuthoring.offHint")}
          </p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span>{t("agentAuthoring.label")}</span>
          <Switch checked={draft ?? enabled} onCheckedChange={setDraft} />
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(null);
              setOpen(false);
            }}
          >
            {t("common:btn.cancel")}
          </Button>
          <Button
            type="button"
            disabled={draft === null || draft === enabled}
            onClick={() => {
              setAgentAuthoringEnabled(draft ?? enabled);
              setDraft(null);
              setOpen(false);
            }}
          >
            {t("common:btn.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
