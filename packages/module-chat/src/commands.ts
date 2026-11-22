// SPDX-License-Identifier: Apache-2.0

/**
 * What the composer offers (`GET /api/orgs/:orgId/chat/commands`): the skills the conversation
 * can pin and the agents the caller can launch, as the platform MCP server serves them
 * (`skills/list`, `prompts/list`) in the spaces the conversation acts in.
 */

import { z } from "zod";

const chatSkillCommandSchema = z.object({
  /** `@scope/name`: what `pinned_skills` holds. */
  id: z.string(),
  /** The skill's frontmatter `name`: what the user types after `/`. */
  name: z.string(),
  description: z.string(),
  /** `null` for a draft. */
  version: z.string().nullable(),
});

const chatAgentCommandSchema = z.object({
  /** The prompt name (`run-<agent>`): what a `data-agent-prompt` part names. */
  name: z.string(),
  title: z.string(),
  description: z.string(),
});

export const chatCommandsSchema = z.object({
  skills: z.array(chatSkillCommandSchema),
  agents: z.array(chatAgentCommandSchema),
});

export type ChatSkillCommand = z.infer<typeof chatSkillCommandSchema>;
export type ChatAgentCommand = z.infer<typeof chatAgentCommandSchema>;
export type ChatCommands = z.infer<typeof chatCommandsSchema>;
