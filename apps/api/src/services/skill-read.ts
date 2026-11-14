// SPDX-License-Identifier: Apache-2.0

// `skill://` reads: the file explorer's readers, with their own access rule.

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
import { conflict, notFound } from "../lib/errors.ts";
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
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";

const SKILLS_READ = packagePermission("skill", "read");
const CHAT_TURN = "chat:write";

/**
 * The space a skill read targets, with the caller's permissions there: the live
 * grants under the token's ceiling. An org-wide MCP connection reads each space
 * it reaches with that space's permissions, not those of the space it entered.
 */
export interface SkillReadSpace extends SpaceScope {
  permissions: ReadonlySet<string>;
}

/**
 * The skills this request's chat turn injected, or `null`. The claim is a
 * chat-turn grant: it holds in the turn's space only, and lapses with the
 * caller's LIVE `chat:write` there — revoking chat access revokes it. A
 * malformed claim is ignored.
 *
 * This IS a hard-coded auth method, the chat module's: core names it (in
 * `@appstrate/core/chat-contract`) because a claim any loaded strategy could
 * carry would not be a boundary. Trusting another minter of this claim is
 * therefore a deliberate core change, not a module capability — the same
 * stance as the bearer allowlist in `lib/bearer-only.ts`.
 */
function turnClaim(c: Context<AppEnv>, space: SkillReadSpace): InjectedSkills["skills"] | null {
  if (c.get("authMethod") !== CHAT_LOOPBACK_AUTH_METHOD) return null;
  if (!space.permissions.has(CHAT_TURN)) return null;
  const claim = injectedSkillsSchema.safeParse(c.get("authExtra")?.[INJECTED_SKILLS_AUTH_EXTRA]);
  return claim.success && claim.data.spaceId === space.spaceId ? claim.data.skills : null;
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
 * `lock_version` injected; a `definition` other than the one injected is
 * refused. Any other skill: `skills:read`, as `GET …/files`, at `definition`
 * when named (the draft only for whoever may write the package), else at the
 * file explorer's default.
 */
async function resolveSkillReadAccess(
  c: Context<AppEnv>,
  space: SkillReadSpace,
  packageId: string,
  definition: SkillDefinitionSelector | undefined,
): Promise<SkillReadAccess | null> {
  const claim = turnClaim(c, space);
  if (claim && Object.hasOwn(claim, packageId)) {
    const served = claim[packageId]!;
    const pkg = await findFileExplorerPackage(space, packageId);
    if (pkg?.type !== "skill") return null;
    if (pkg.source === "system") return definition === "draft" ? null : { pkg, spec: undefined };
    if (definition !== undefined && definition !== served.definition) return null;
    if (served.definition === "draft") {
      return { pkg, spec: undefined, draftLock: served.lockVersion };
    }
    return served.version === null ? null : { pkg, spec: served.version };
  }
  if (space.permissions.has(SKILLS_READ)) {
    const pkg = await findFileExplorerPackage(space, packageId);
    if (pkg?.type === "skill") {
      const explicit =
        definition === undefined
          ? undefined
          : definition === "draft"
            ? VERSION_SELECTOR_DRAFT
            : "latest";
      return { pkg, spec: await resolveFileExplorerVersion(c, pkg, explicit) };
    }
  }
  return null;
}

/**
 * The draft with the `lock_version` it is read at; 409 when `pinned` names
 * another. Read under the draft lock a save holds across its row write, upload
 * and commit — the one publication reads under — so the version returned and
 * the files read are the same draft.
 */
function readDraft(pkg: FileExplorerPackage, pinned: number | undefined): Promise<SkillFiles> {
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
    if (!row) throw notFound(`Package '${pkg.id}' not found`);
    if (pinned !== undefined && row.lockVersion !== pinned) {
      throw conflict(
        "injected_draft_changed",
        `The draft of '${pkg.id}' changed since this conversation turn injected it, so its ` +
          `files no longer match the SKILL.md you hold. The next turn injects the current draft.`,
      );
    }
    const draft = { ...pkg, ...row };
    const snapshot = await readPackageSnapshot(draft, await resolvePackageFileValidator(draft));
    return { ...snapshot, lockVersion: row.lockVersion };
  });
}

/** The files of a skill read, with the draft `lock_version` they were read at (`null` outside a draft). */
interface SkillFiles extends PackageFileSnapshot {
  lockVersion: number | null;
}

/** A granted skill read: which definition it serves, its files read on demand. */
export interface SkillRead {
  packageId: string;
  /** `null` for the stored tree (the draft, or a system package). */
  version: string | null;
  definition: "draft" | "published";
  /** The integrity of the published archive served, `null` for the stored tree. */
  integrity: string | null;
  readSnapshot: () => Promise<SkillFiles>;
}

export type SkillDefinitionSelector = "published" | "draft";

/**
 * The access rule applied, without reading the files: `null` when refused, the
 * caller answers it as REST does (403, else 404). `definition` names the
 * definition to read (see `resolveSkillReadAccess`). `readSnapshot` of a draft
 * pinned by the turn throws 409 `injected_draft_changed` once that draft moved;
 * a draft's files come with the `lock_version` they were read at.
 */
export async function resolveSkillRead(
  c: Context<AppEnv>,
  space: SkillReadSpace,
  packageId: string,
  definition?: SkillDefinitionSelector,
): Promise<SkillRead | null> {
  const access = await resolveSkillReadAccess(c, space, packageId, definition);
  if (!access) return null;
  const { pkg, spec, draftLock } = access;
  const validator = await resolvePackageFileValidator(pkg, spec);
  const served = servedDefinition(pkg, spec);
  return {
    packageId: pkg.id,
    version: validator.kind === "version" ? validator.version : null,
    integrity: validator.kind === "version" ? validator.integrity : null,
    definition: served,
    readSnapshot: async () =>
      served === "draft"
        ? readDraft(pkg, draftLock)
        : { ...(await readPackageSnapshot(pkg, validator)), lockVersion: null },
  };
}
