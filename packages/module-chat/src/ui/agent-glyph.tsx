// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's glyph beside its name: the identity tile it carries in the `/chat/commands` data (the
 * same one the rest of the app draws), the plain bot icon when the data has no such agent yet
 * (deleted agent, data not loaded). The `/` menu, the composer chip and the sent chip share it.
 */

import { BotIcon } from "lucide-react";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import type { ChatAgentCommand } from "../commands.ts";
import { useChatCommands } from "./use-chat-commands.ts";

/** What an agent's tile reads of it. */
export type AgentAppearance = Pick<ChatAgentCommand, "packageId" | "icon" | "color">;

export function AgentGlyph({
  agent,
  label,
  className,
}: {
  agent: AgentAppearance | undefined;
  label: string;
  className?: string;
}) {
  if (!agent) return <BotIcon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
  return (
    <IdentityTile
      icon={agent.icon}
      color={agent.color}
      seed={agent.packageId}
      label={label}
      fallbackIcon="lucide:bot"
      className={cn("size-4 shrink-0 rounded-sm", className)}
    />
  );
}

/** The glyph of an agent the commands query knows (its key is shared with the `/` menu). */
export function KnownAgentGlyph({
  agentRef,
  label,
  className,
}: {
  agentRef: { promptName: string } | { packageId: string };
  label: string;
  className?: string;
}) {
  const { data } = useChatCommands(true);
  const agent = data?.agents.find((a) =>
    "packageId" in agentRef ? a.packageId === agentRef.packageId : a.name === agentRef.promptName,
  );
  return <AgentGlyph agent={agent} label={label} className={className} />;
}
