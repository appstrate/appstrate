// SPDX-License-Identifier: Apache-2.0

// The composer's `/` menu (`GET …/chat/commands`): pinnable skills and launchable agents.

import { z } from "zod";

const chatSkillCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** `null` for a draft. */
  version: z.string().nullable(),
  /**
   * The listed UTF-8 size of its `SKILL.md`: an upper bound on the characters it takes of the
   * pins' shared budget (equal for ASCII text); `null` when the server lists no sizes.
   */
  bytes: z.number().int().nonnegative().nullable(),
});

const chatAgentCommandSchema = z.object({
  /** The prompt name (`run-<agent>`): what a `data-agent-prompt` part names. */
  name: z.string(),
  title: z.string(),
  description: z.string(),
  packageId: z.string(),
  /** `@appstrate/core/appearance` grammar, `null` when none. */
  icon: z.string().nullable(),
  color: z.string().nullable(),
});

export const chatCommandsSchema = z.object({
  skills: z.array(chatSkillCommandSchema),
  agents: z.array(chatAgentCommandSchema),
});

export type ChatSkillCommand = z.infer<typeof chatSkillCommandSchema>;
export type ChatAgentCommand = z.infer<typeof chatAgentCommandSchema>;
export type ChatCommands = z.infer<typeof chatCommandsSchema>;
