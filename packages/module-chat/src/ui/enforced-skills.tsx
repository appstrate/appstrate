// SPDX-License-Identifier: Apache-2.0

import { LockIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { useChatHost, type GetHeaders } from "./runtime-context.ts";
import { useEnforcedSkills } from "./use-enforced-skills.ts";

/** For a member who chats without `skills:read`: the space's policy applies to them too. */
export function EnforcedSkillsIndicator({ getHeaders }: { getHeaders: GetHeaders | undefined }) {
  const { t } = useChatHost();
  const { data: enforced } = useEnforcedSkills(getHeaders);
  if (!enforced || enforced.length === 0) return null;
  const names = enforced.map((skill) => skill.display_name ?? skill.packageId).join(", ");

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="note"
            tabIndex={0}
            data-testid="enforced-skills-indicator"
            aria-label={t("skills.enforcedIndicator", { names })}
            className="text-muted-foreground flex h-8 max-w-48 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs"
          >
            <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{names}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-xs">
          <p className="font-medium">{t("skills.enforcedTitle")}</p>
          <p className="text-muted-foreground mt-0.5">{names}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
