// SPDX-License-Identifier: Apache-2.0

// The skills the space imposes on every conversation: one read, shared by the
// skill picker and, when the caller cannot pin skills, a read-only indicator.

import { useQuery } from "@tanstack/react-query";
import { LockIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { fetchEnforcedSkills } from "./chat-skills.ts";
import { useChatHost, type GetHeaders } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";

/**
 * Default freshness on purpose: a toggle in the space library is the whole
 * point of this read, and the picker remounts with each conversation, which
 * refetches it without a cross-module invalidation.
 */
export function useEnforcedSkills(getHeaders: GetHeaders | undefined) {
  const spaceId = spaceIdFromHeaders(getHeaders);
  return useQuery({
    queryKey: ["chat", "enforced-skills", spaceId],
    queryFn: () => fetchEnforcedSkills(getHeaders),
    // The route reads the space from `X-Space-Id`; without one it is a 400.
    enabled: !!spaceId,
  });
}

/**
 * For a member who chats without `skills:read`: no picker, but the space's
 * policy still applies to them, so its names are shown. Nothing when the space
 * imposes nothing, or while the read has no answer.
 */
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
