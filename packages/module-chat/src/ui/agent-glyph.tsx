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
import { useKnownAgent, type AgentRef } from "./use-chat-commands.ts";

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

/** The glyph of an agent the commands query knows. */
export function KnownAgentGlyph({
  agentRef,
  label,
  className,
}: {
  agentRef: AgentRef;
  label: string;
  className?: string;
}) {
  return <AgentGlyph agent={useKnownAgent(agentRef)} label={label} className={className} />;
}

/**
 * An agent's tile at a run's lead (32px): its identity tile, a neutral bot tile of the same size
 * for an inline run or an agent the data does not hold.
 */
export function AgentTile({ agent, label }: { agent: AgentAppearance | undefined; label: string }) {
  if (!agent) {
    return (
      <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg">
        <BotIcon className="size-4" aria-hidden="true" />
      </span>
    );
  }
  return <AgentGlyph agent={agent} label={label} className="size-8 rounded-lg" />;
}
