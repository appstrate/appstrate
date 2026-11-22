// SPDX-License-Identifier: Apache-2.0

import { BotIcon } from "lucide-react";
import { useChatHost } from "./runtime-context.ts";

/** The agent a user message launches: its title above the bubble. The launch text is never shown. */
export function AgentPromptChip({ title }: { title: string }) {
  const { t } = useChatHost();
  return (
    <span
      data-testid="agent-prompt-chip"
      className="bg-muted/40 text-muted-foreground inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm md:text-xs"
    >
      <BotIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t("thread.agentPrompt")}</span>
      <span className="truncate">{title}</span>
    </span>
  );
}
