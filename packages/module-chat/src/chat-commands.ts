// SPDX-License-Identifier: Apache-2.0

/**
 * What `GET /api/orgs/:orgId/chat/commands` answers: the composer's `/` menu, read as an MCP
 * client reads the platform server (`skills/list`, `prompts/list`) over one connection of the
 * caller's own, closed before the answer.
 */

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { logger } from "./logger.ts";
import { CALLER_READ_TIMEOUT_MS, readSkillsOver } from "./prompt.ts";
import type { ChatAgentCommand, ChatCommands, ChatSkillCommand } from "./commands.ts";

export async function readChatCommands(
  openCaller: (signal: AbortSignal) => Promise<AppstrateMcpClient>,
  spaces: readonly string[],
  opts: {
    /** `skills:read`: without it the skills half is empty, whatever the server would list. */
    readsSkills: boolean;
    /** `skills:write`: the drafts the caller reads are listed as the skill they stand for. */
    catalogueDrafts: boolean;
  },
): Promise<ChatCommands> {
  const signal = AbortSignal.timeout(CALLER_READ_TIMEOUT_MS);
  let client: AppstrateMcpClient;
  try {
    client = await openCaller(signal);
  } catch (err) {
    logger.warn("commands connection unavailable — the composer's commands left empty", {
      err: String(err),
    });
    return { skills: [], agents: [] };
  }
  try {
    const [skills, agents] = await Promise.all([
      opts.readsSkills
        ? readSkillsOver(client, signal, spaces, {
            catalogue: true,
            catalogueDrafts: opts.catalogueDrafts,
            chosen: [],
          }).then(({ catalogue }) =>
            catalogue.map((skill): ChatSkillCommand => ({
              id: skill.packageId,
              name: skill.name,
              description: skill.description,
              version: skill.version,
            })),
          )
        : [],
      client.listPrompts({ signal }).then(
        ({ prompts }) =>
          prompts.map((prompt): ChatAgentCommand => ({
            name: prompt.name,
            title: prompt.title ?? prompt.name,
            description: prompt.description ?? "",
          })),
        (err: unknown) => {
          logger.warn("prompts/list failed — the composer's agents left empty", {
            err: String(err),
          });
          return [];
        },
      ),
    ]);
    return { skills, agents };
  } finally {
    await client.close().catch(() => {});
  }
}
