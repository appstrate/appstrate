// SPDX-License-Identifier: Apache-2.0

// The composer's `/` menu (`GET …/chat/commands`): pinnable skills and launchable agents.

import { z } from "zod";

const chatSkillCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** `null` for a draft. */
  version: z.string().nullable(),
  /** Listed UTF-8 size of `SKILL.md`, an upper bound on its share of the pins' budget. */
  bytes: z.number().int().nonnegative().nullable(),
});

const chatAgentCommandSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  packageId: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  /** The integrations the agent uses, as the agents index names and draws them. */
  integrations: z.array(
    z.object({ id: z.string(), name: z.string(), icon: z.string().nullable() }),
  ),
});

export const catalogueSources = ["published_skills", "draft_skills", "agents"] as const;
export type CatalogueSource = (typeof catalogueSources)[number];

export const chatCommandsSchema = z.object({
  unavailable: z.array(z.enum(catalogueSources)).optional(),
  skills: z.array(chatSkillCommandSchema),
  agents: z.array(chatAgentCommandSchema),
});

export type ChatSkillCommand = z.infer<typeof chatSkillCommandSchema>;
export type ChatAgentCommand = z.infer<typeof chatAgentCommandSchema>;
export type ChatCommands = z.infer<typeof chatCommandsSchema>;
