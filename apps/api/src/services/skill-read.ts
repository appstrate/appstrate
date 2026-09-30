// SPDX-License-Identifier: Apache-2.0

// MCP `read_skill` (#1586): the file explorer's readers, with its own access rule.

import type { Context } from "hono";
import { packagePermission } from "@appstrate/core/permissions";
import {
  CHAT_LOOPBACK_AUTH_METHOD,
  INJECTED_SKILLS_AUTH_EXTRA,
  injectedSkillsSchema,
  type InjectedSkills,
} from "@appstrate/core/chat-contract";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { conflict } from "../lib/errors.ts";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "../lib/scope.ts";
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
import { withPackageDraftLock } from "./package-locks.ts";

const SKILLS_READ = packagePermission("skill", "read");
const CHAT_TURN = "chat:write";

/**
 * The skills this request's chat turn injected, or `null`. The claim is a
 * chat-turn grant: it holds in the turn's space only, and lapses with the
 * caller's LIVE `chat:write` there (the hop's permissions are the live grants
 * under the token's ceiling) — revoking chat access revokes it. A malformed
 * claim is ignored.
 *
 * This IS a hard-coded auth method, the chat module's: core names it (in
 * `@appstrate/core/chat-contract`) because a claim any loaded strategy could
 * carry would not be a boundary. Trusting another minter of this claim is
 * therefore a deliberate core change, not a module capability — the same
 * stance as the bearer allowlist in `lib/bearer-only.ts`.
 */
function turnClaim(c: Context<AppEnv>, scope: SpaceScope): InjectedSkills["skills"] | null {
  if (c.get("authMethod") !== CHAT_LOOPBACK_AUTH_METHOD) return null;
  if (!c.get("permissions")?.has(CHAT_TURN)) return null;
  const claim = injectedSkillsSchema.safeParse(c.get("authExtra")?.[INJECTED_SKILLS_AUTH_EXTRA]);
  return claim.success && claim.data.spaceId === scope.spaceId ? claim.data.skills : null;
}

/** What a read serves: `spec` `undefined` = the stored tree; `draftLock` pins that tree. */
interface SkillReadAccess {
  pkg: FileExplorerPackage;
  spec: string | undefined;
  draftLock?: number;
}

/**
 * Which definition this caller may read, `null` when refused. A skill the turn
 * injected answers from the claim alone, without `skills:*` — the chat already
 * put its SKILL.md in context — and never falls through: the published version
 * it was served at (a system skill's shipped tree), or its draft pinned to the
 * `lock_version` injected. Any other skill: `skills:read`, as `GET …/files`.
 */
async function resolveSkillReadAccess(
  c: Context<AppEnv>,
  scope: SpaceScope,
  packageId: string,
): Promise<SkillReadAccess | null> {
  const claim = turnClaim(c, scope);
  if (claim && Object.hasOwn(claim, packageId)) {
    const served = claim[packageId]!;
    const pkg = await findFileExplorerPackage(scope, packageId);
    if (pkg?.type !== "skill") return null;
    if (pkg.source === "system") return { pkg, spec: undefined };
    if (served.definition === "draft") {
      return { pkg, spec: undefined, draftLock: served.lockVersion };
    }
    return served.version === null ? null : { pkg, spec: served.version };
  }
  if (c.get("permissions")?.has(SKILLS_READ)) {
    const pkg = await findFileExplorerPackage(scope, packageId);
    if (pkg?.type === "skill") {
      return { pkg, spec: await resolveFileExplorerVersion(c, pkg, undefined) };
    }
  }
  return null;
}

/**
 * The draft at `lockVersion`, or 409. Read under the draft lock a save holds
 * across its row write, upload and commit — the one publication reads under —
 * so the row checked and the files read are the same draft.
 */
function readPinnedDraft(pkg: FileExplorerPackage, lockVersion: number) {
  return withPackageDraftLock(pkg.id, async (tx) => {
    const [row] = await tx
      .select({
        draftManifest: packages.draftManifest,
        draftContent: packages.draftContent,
        lockVersion: packages.lockVersion,
      })
      .from(packages)
      .where(eq(packages.id, pkg.id))
      .limit(1);
    if (row?.lockVersion !== lockVersion) {
      throw conflict(
        "injected_draft_changed",
        `The draft of '${pkg.id}' changed since this conversation turn injected it, so its ` +
          `files no longer match the SKILL.md you hold. The next turn injects the current draft.`,
      );
    }
    const draft = { ...pkg, ...row };
    return readPackageSnapshot(draft, await resolvePackageFileValidator(draft, undefined));
  });
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
  const { pkg, spec, draftLock } = access;
  const validator = await resolvePackageFileValidator(pkg, spec);
  return {
    packageId: pkg.id,
    version: validator.kind === "version" ? validator.version : null,
    definition: servedDefinition(pkg, spec),
    snapshot:
      draftLock === undefined
        ? await readPackageSnapshot(pkg, validator)
        : await readPinnedDraft(pkg, draftLock),
  };
}
