// SPDX-License-Identifier: Apache-2.0

import type { ChatSkillMode } from "@appstrate/db/schema";

/**
 * The permissions a chat turn acts with: the caller's own, minus `agents:write`
 * when agent authoring is off, and minus every `skills:*` in the `strict` skill
 * mode. The turn's MCP loopback token is minted from this set, so the platform's
 * existing guards refuse creating or editing an agent and composing an inline
 * one (which needs `agents:write` AND `agents:run`), and in `strict` any skill
 * act: listing, loading, declaring — and writing, whose response echoes the
 * `SKILL.md`. The chosen skills reach the model injected, read with the caller's
 * own authority. The switches only narrow the caller's grants, never widen them.
 */
export function turnPermissions(
  permissions: Iterable<string>,
  opts: { authoring: boolean; skillMode: ChatSkillMode },
): string[] {
  const strict = opts.skillMode === "strict";
  return [...permissions].filter(
    (permission) =>
      !(permission === "agents:write" && !opts.authoring) &&
      !(strict && permission.startsWith("skills:")),
  );
}
