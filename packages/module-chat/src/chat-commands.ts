// SPDX-License-Identifier: Apache-2.0

/**
 * What `GET /api/orgs/:orgId/chat/commands` answers: the composer's `/` menu, read as an MCP
 * client reads the platform server (`skills/list`, `prompts/list`) over one connection of the
 * caller's own, closed before the answer. A server that cannot be reached is a 502; a half that
 * fails to read is left empty, as the turn tolerates it.
 */

import { readAgentPromptMeta, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { badGateway } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { withCallerClient } from "./platform-mcp.ts";
import { readSkillsOver } from "./prompt.ts";
import type { ChatAgentCommand, ChatCommands, ChatSkillCommand } from "./commands.ts";

export async function readChatCommands(
  openCaller: (signal: AbortSignal) => Promise<AppstrateMcpClient>,
  spaces: readonly string[],
  opts: {
    /** `skills:read`: without it the skills half is empty, whatever the server would list. */
    readsSkills: boolean;
    /** See `turnUsesDrafts`. */
    drafts: boolean;
  },
): Promise<ChatCommands> {
  return withCallerClient(
    openCaller,
    async (client, signal) => {
      const [skills, agents] = await Promise.all([
        opts.readsSkills
          ? readSkillsOver(client, signal, spaces, {
              catalogue: true,
              drafts: opts.drafts,
              read: [],
            }).then(({ catalogue }) =>
              catalogue.map((skill): ChatSkillCommand => ({
                id: skill.packageId,
                name: skill.name,
                description: skill.description,
                version: skill.version,
                bytes: skill.bytes,
              })),
            )
          : [],
        client.listPrompts({ signal }).then(
          ({ prompts }) =>
            prompts.flatMap((prompt): ChatAgentCommand[] => {
              // The platform server always sets the meta; without it the agent has no id to seed
              // its colour from, so it is left out rather than drawn under a made-up identity.
              const meta = readAgentPromptMeta(prompt._meta);
              if (!meta) {
                logger.warn("agent prompt without a valid agent meta — left out", {
                  prompt: prompt.name,
                });
                return [];
              }
              return [
                {
                  name: prompt.name,
                  title: prompt.title ?? prompt.name,
                  description: prompt.description ?? "",
                  packageId: meta.packageId,
                  icon: meta.icon,
                  color: meta.color,
                },
              ];
            }),
          (err: unknown) => {
            logger.warn("prompts/list failed — the composer's agents left empty", {
              err: String(err),
            });
            return [];
          },
        ),
      ]);
      return { skills, agents };
    },
    (err) => {
      // An unreachable server is not "nothing to offer": the composer must not read it as such.
      logger.warn("commands connection unavailable", { err: String(err) });
      throw badGateway("The platform's MCP server could not be reached.");
    },
  );
}
