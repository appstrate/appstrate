// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_WRITE_PERMISSIONS } from "@appstrate/core/permissions";
import type { ChatSkillMode } from "@appstrate/db/schema";

/**
 * The permissions a chat turn acts with: the caller's own, minus the write on
 * every package type when package authoring is off, and minus every `skills:*`
 * in the `strict` skill mode. The turn's MCP loopback token is minted from this
 * set, so the platform's existing guards refuse creating, editing or importing
 * any package and composing an inline agent (which needs `agents:write` AND
 * `agents:run`), and in `strict` any skill
 * act: listing, loading, declaring — and writing, whose response echoes the
 * `SKILL.md`. The chosen skills reach the model injected, read with the caller's
 * own authority. The switches only narrow the caller's grants, never widen them.
 */
const WRITES: ReadonlySet<string> = new Set(PACKAGE_WRITE_PERMISSIONS);

export function turnPermissions(
  permissions: Iterable<string>,
  opts: { authoring: boolean; skillMode: ChatSkillMode },
): string[] {
  const strict = opts.skillMode === "strict";
  return [...permissions].filter(
    (permission) =>
      !(!opts.authoring && WRITES.has(permission)) && !(strict && permission.startsWith("skills:")),
  );
}
