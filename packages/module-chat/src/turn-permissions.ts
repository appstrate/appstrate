// SPDX-License-Identifier: Apache-2.0

import type { ChatSkillMode } from "@appstrate/db/schema";

/**
 * The permissions a chat turn acts with: the caller's own, minus `agents:write`
 * when agent authoring is off, and minus `skills:read` in the `strict` skill
 * mode. The turn's MCP loopback token is minted from this set, so the platform's
 * existing guards refuse creating or editing an agent and composing an inline
 * one (which needs `agents:write` AND `agents:run`), and in `strict` listing,
 * loading or declaring any skill: the chosen ones reach the model injected, read
 * with the caller's own authority. The switches only narrow the caller's grants,
 * never widen them.
 */
export function turnPermissions(
  permissions: Iterable<string>,
  opts: { authoring: boolean; skillMode: ChatSkillMode },
): string[] {
  const withheld = new Set<string>();
  if (!opts.authoring) withheld.add("agents:write");
  if (opts.skillMode === "strict") withheld.add("skills:read");
  return [...permissions].filter((permission) => !withheld.has(permission));
}
