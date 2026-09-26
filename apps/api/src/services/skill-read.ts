// SPDX-License-Identifier: Apache-2.0

// MCP `read_skill` (#1586): the file explorer's readers, with its own access rule.

import type { Context } from "hono";
import { packagePermission } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { listEnforcedChatSkills } from "./chat-enforced-skills.ts";
import {
  findFileExplorerPackage,
  resolveFileExplorerVersion,
  servedDefinition,
  type FileExplorerPackage,
} from "./package-file-explorer.ts";
import {
  readPackageSnapshot,
  resolvePackageFileValidator,
  type PackageFileSnapshot,
} from "./package-files.ts";

const SKILLS_READ = packagePermission("skill", "read");
// Who an enforced SKILL.md is disclosed to: the gate of the turn injecting it.
const CHAT_TURN = "chat:write";

/**
 * Which definition this caller may read (`spec` `undefined` = the stored tree),
 * `null` when refused. Enforced ∧ active here for a chatter comes first: its
 * `latest` published version only, so an author's file reads never disagree
 * with the SKILL.md their turn injects. Then `skills:read`: what `GET …/files`
 * serves. A refusal reveals nothing `GET /api/chat/enforced-skills` does not.
 */
async function resolveSkillReadAccess(
  c: Context<AppEnv>,
  scope: SpaceScope,
  packageId: string,
): Promise<{ pkg: FileExplorerPackage; spec: string | undefined } | null> {
  const permissions = c.get("permissions");
  if (permissions?.has(CHAT_TURN)) {
    const enforced = (await listEnforcedChatSkills(scope.orgId, scope.spaceId)).find(
      (skill) => skill.packageId === packageId,
    );
    const pkg = enforced?.version ? await findFileExplorerPackage(scope, packageId) : null;
    if (pkg && enforced?.version) return { pkg, spec: enforced.version };
  }
  if (permissions?.has(SKILLS_READ)) {
    const pkg = await findFileExplorerPackage(scope, packageId);
    if (pkg?.type === "skill") {
      return { pkg, spec: await resolveFileExplorerVersion(c, pkg, undefined) };
    }
  }
  return null;
}

export interface SkillSnapshot {
  packageId: string;
  /** `null` for the stored tree (the draft, or a system package). */
  version: string | null;
  definition: "draft" | "published";
  snapshot: PackageFileSnapshot;
}

/** `null` when refused; the caller answers it as REST does (403, else 404). */
export async function readSkillSnapshot(
  c: Context<AppEnv>,
  scope: SpaceScope,
  packageId: string,
): Promise<SkillSnapshot | null> {
  const access = await resolveSkillReadAccess(c, scope, packageId);
  if (!access) return null;
  const { pkg, spec } = access;
  const validator = await resolvePackageFileValidator(pkg, spec);
  return {
    packageId: pkg.id,
    version: validator.kind === "version" ? validator.version : null,
    definition: servedDefinition(pkg, spec),
    snapshot: await readPackageSnapshot(pkg, validator),
  };
}
