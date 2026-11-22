// SPDX-License-Identifier: Apache-2.0

import type { ChatAgentCommand, ChatCommands } from "../commands.ts";

/** What an agent's tile reads of it. */
export type AgentAppearance = Pick<ChatAgentCommand, "packageId" | "icon" | "color">;

/** The agent a directive names: its id is the prompt name. */
export function agentByPromptName(
  commands: ChatCommands | undefined,
  name: string,
): ChatAgentCommand | undefined {
  return commands?.agents.find((agent) => agent.name === name);
}
