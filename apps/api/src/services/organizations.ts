// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import { isUniqueViolation } from "../lib/db-helpers.ts";
import { nextScheduleVersion } from "../lib/schedule-version.ts";
import { db } from "@appstrate/db/client";
import { ApiError, conflict, forbidden, notFound } from "../lib/errors.ts";
import { CURRENT_API_VERSION } from "../lib/api-versions.ts";
import { toISO, toISORequired } from "../lib/date-helpers.ts";
import {
  organizations,
  organizationMembers,
  profiles,
  user,
  runs,
  runLogs,
  packages,
  orgInvitations,
  notifications,
  runReads,
  schedules,
  files,
  uploads,
  apiKeys,
  modelProviderCredentials,
  modelProviderPairings,
  spaces,
  spaceMembers,
  integrationConnections,
  type ScheduleDisabledReason,
} from "@appstrate/db/schema";
import {
  and,
  eq,
  ne,
  inArray,
  isNull,
  notInArray,
  count,
  countDistinct,
  sql,
  asc,
  type SQL,
} from "drizzle-orm";
import type { OrgRole } from "../types/index.ts";
import type { SpaceRoleAssignment } from "@appstrate/shared-types";
import {
  defaultPersonalSpaceRole,
  lockOrgSpaceRole,
  ADMIN_PRESET,
  PERSONAL_SPACE_DEFAULT_COLUMNS,
  personalSpaceDefaultOn,
  personalSpaceDefaultRef,
  psr,
  spacePermissions,
  type SpaceRoleRef,
} from "../lib/space-role.ts";
import type { SpaceRoleColumns } from "../lib/space-role-assignment.ts";
import {
  isUuid,
  lockOrganizationRow,
  scopedWhere,
  type DbOrTx,
  type Tx,
} from "../lib/db-helpers.ts";
import { countInProgressRuns, orgRunConcurrencyLockKey } from "./state/runs.ts";
import { removeScheduleJobs } from "./scheduler.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { runWorkspaceDeletionJobs } from "./run-workspace-storage.ts";
import { orgPackageStorageDeletionJobs } from "./package-storage-deletion.ts";
import { orgApiVersionCache } from "./org-settings-cache.ts";
import { clearResolvedModelCache } from "./resolved-model-cache.ts";
import {
  deleteSpaceMembershipsInOrg,
  lockOrgMember,
  lockSpacesOfSharedConnections,
  sharesLostIn,
  unshareConnectionsOfOwnersWithoutAccess,
} from "./space-members.ts";
import {
  integrationsNamingAny,
  selectForeignNamingScheduleIds,
} from "./schedules-naming-connection.ts";
import { batchLoadScheduleEndUserNames, batchLoadUserNames } from "../lib/user-helpers.ts";
import { actorFromIds } from "../lib/actor.ts";
import { orphanPersonalSpaces } from "./spaces.ts";
import { ensurePersonalSpace, isPlatformAccount, provisionOrg } from "@appstrate/db/provision-org";
import type { ConnectionShare, RevokedSpaceAssignment } from "./space-members.ts";
import { assignableRolesForMember, canRemoveMember } from "@appstrate/shared-types";
import { endOAuthAccessInOrg } from "./oauth-token-revocation.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";

interface OrgResult {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Running total of durable file bytes stored by this org
   * (`organizations.files_bytes_used`) — the value the synchronous
   * `ORG_STORAGE_QUOTA_BYTES` gate is checked against. Surfaced so the org
   * settings screen can show consumption against the quota.
   */
  filesBytesUsed: number;
  /**
   * Per-org durable-file storage limit override in bytes
   * (`organizations.files_bytes_limit`), or null when no override is set (the
   * org falls back to the global `ORG_STORAGE_QUOTA_BYTES`). Surfaced so the org
   * detail endpoint can report the raw override alongside the effective limit.
   */
  filesBytesLimit: number | null;
  /** When deletion was reserved (`organizations.deleting_at`), or null. */
  deletingAt: string | null;
}

function toOrgResult(row: typeof organizations.$inferSelect): OrgResult {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    color: row.color,
    createdBy: row.createdBy ?? "",
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
    filesBytesUsed: row.filesBytesUsed,
    filesBytesLimit: row.filesBytesLimit,
    deletingAt: toISO(row.deletingAt),
  };
}

function rethrowOrgWriteError(err: unknown, slug: string | undefined): never {
  if (slug !== undefined && isUniqueViolation(err, "organizations_slug_unique")) {
    throw new ApiError({
      status: 400,
      code: "slug_taken",
      title: "Bad Request",
      detail: `Slug '${slug}' is already in use`,
      cause: err,
    });
  }
  throw err;
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string,
): Promise<OrgResult> {
  // Org row, owner membership, default space and the owner's personal space are
  // ONE unit — `provisionOrg` (`@appstrate/db/provision-org`), shared with the
  // bootstrap path so neither can provision half an organization. A default
  // space created after this commit, outside the transaction, is an
  // organization that can commit without one.
  const { org } = await db
    .transaction(async (tx) =>
      provisionOrg(tx, {
        name,
        slug,
        ownerUserId: userId,
        orgSettings: { api_version: CURRENT_API_VERSION },
      }),
    )
    .catch((err: unknown) => rethrowOrgWriteError(err, slug));

  // The initial `orgSettings` write above is a settings writer like any other:
  // a pin read for this id that raced the insert (and cached "no pin" for a
  // row that did not exist yet) must not outlive the commit.
  orgApiVersionCache.invalidate(org.id);

  return toOrgResult(org);
}

export async function getUserOrganizations(
  userId: string,
  orgIdFilter?: string,
): Promise<(OrgResult & { role: OrgRole })[]> {
  const rows = await db
    .select({
      org: organizations,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(
      orgIdFilter
        ? and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgIdFilter))
        : eq(organizationMembers.userId, userId),
    )
    // Oldest membership first.
    .orderBy(asc(organizationMembers.joinedAt), asc(organizations.id));

  return rows.map((row) => ({
    ...toOrgResult(row.org),
    role: row.role,
  }));
}

export async function getOrgById(orgId: string): Promise<OrgResult | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);

  return row ? toOrgResult(row) : null;
}

export async function updateOrganization(
  orgId: string,
  updates: { name?: string; slug?: string; icon?: string | null; color?: string | null },
): Promise<OrgResult> {
  const [row] = await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning()
    .catch((err: unknown) => rethrowOrgWriteError(err, updates.slug));

  if (!row) throw new Error("Failed to update organization");
  return toOrgResult(row);
}

// Re-exporting `orgSettingsSchema` from here died with the second
// `.partial()`: the two readers it had now take the base straight from
// `@appstrate/core/permissions` or the patch schema below.
import {
  orgSettingsReadSchema,
  orgSettingsSchema as orgSettingsBaseSchema,
  spaceRoleReferenceSchema,
  type SpaceRolePreset,
} from "@appstrate/core/permissions";

/**
 * Body of `PATCH /api/orgs/{orgId}/settings` — an RFC 7396 merge over the org settings
 * document, so every member is optional.
 *
 * `.strict()`: an unknown key is a 400, never a silently dropped setting. The OpenAPI registry
 * documents this same schema. `personal_space_role` is a role reference, stored apart
 * ({@link updateOrgSettings}).
 */
export const orgSettingsPatchSchema = orgSettingsBaseSchema
  .extend({ personal_space_role: spaceRoleReferenceSchema })
  .partial()
  .strict();
import type { OrgSettings } from "@appstrate/shared-types";

/** The settings as served: the default role is projected from its two columns as a role reference. */
function toOrgSettings(
  row:
    | {
        orgSettings: unknown;
        personalSpacePresetRole: SpaceRolePreset | null;
        personalSpaceRoleId: string | null;
      }
    | undefined,
): OrgSettings {
  return {
    ...orgSettingsReadSchema.parse(row?.orgSettings ?? {}),
    personal_space_role:
      row?.personalSpaceRoleId != null
        ? { custom_role_id: row.personalSpaceRoleId }
        : { preset_role: row?.personalSpacePresetRole ?? ADMIN_PRESET },
  };
}

/**
 * Uncached, deliberately: the oidc `dashboard_sso_enabled` gate reads through
 * here and a security gate must not depend on a TTL. The one hot-path field
 * (the `api_version` pin) has its own cached reader below.
 */
export async function getOrgSettings(orgId: string): Promise<OrgSettings> {
  const [row] = await db
    .select({
      orgSettings: organizations.orgSettings,
      personalSpacePresetRole: organizations.personalSpacePresetRole,
      personalSpaceRoleId: organizations.personalSpaceRoleId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return toOrgSettings(row);
}

/**
 * The org's `api_version` pin (null when unpinned), read through the 10 s
 * cache in `org-settings-cache.ts`. This is what the api-version middleware
 * calls for strategy-authenticated requests (chat `chatloop_` hops, API keys)
 * that did not pass through `requireOrgContext` — otherwise each hop is one
 * organizations-table query. Every settings writer in this file invalidates
 * the entry after its write commits; the staleness bound and its rationale
 * live on the cache module. Built on the uncached `getOrgSettings` so the two
 * can never read the row differently.
 */
export async function getCachedOrgApiVersion(orgId: string): Promise<string | null> {
  return orgApiVersionCache.get(
    orgId,
    async () => (await getOrgSettings(orgId)).api_version ?? null,
  );
}

/**
 * Orgs whose stored `org_settings.api_version` pin is not one of `supported`.
 *
 * Such an org 400s on every org-scoped route (`middleware/api-version.ts`), so
 * this powers the boot-time diagnostic in `lib/boot.ts`. Filtered in SQL rather
 * than in TS: on an instance with many orgs the unserveable set is expected to
 * be empty, and streaming every org's settings back to filter them here would
 * make a no-op check proportional to tenant count.
 *
 * Orgs with no pin at all are excluded — a missing pin falls back to
 * `CURRENT_API_VERSION` and is not a fault.
 */
export async function listOrgsWithUnsupportedApiVersion(
  supported: readonly string[],
): Promise<Array<{ id: string; apiVersion: string }>> {
  const pin = sql<string>`${organizations.orgSettings} ->> 'api_version'`;
  return db
    .select({ id: organizations.id, apiVersion: pin })
    .from(organizations)
    .where(and(sql`${pin} IS NOT NULL`, notInArray(pin, [...supported])));
}

/**
 * `personal_space_role` goes in `personal_space_preset_role` or `personal_space_role_id`, one set
 * and the other cleared (RBAC spec §3.6). The custom role is share-locked, so `deleteSpaceRole` answers 409, not the FK.
 */
export async function updateOrgSettings(
  orgId: string,
  updates: z.infer<typeof orgSettingsPatchSchema>,
): Promise<OrgSettings> {
  const { personal_space_role: personalSpaceRole, ...documentUpdates } = updates;
  const row = await db.transaction(async (tx) => {
    // Merge server-side via JSONB concatenation so concurrent admins toggling
    // different keys don't clobber each other (read-modify-write would race).
    const merged = sql`COALESCE(${organizations.orgSettings}, '{}'::jsonb) || ${JSON.stringify(documentUpdates)}::jsonb`;
    let defaultRole: {
      personalSpacePresetRole: SpaceRolePreset | null;
      personalSpaceRoleId: string | null;
    } | null = null;
    if (personalSpaceRole !== undefined && "preset_role" in personalSpaceRole) {
      defaultRole = {
        personalSpacePresetRole: personalSpaceRole.preset_role,
        personalSpaceRoleId: null,
      };
    } else if (personalSpaceRole !== undefined) {
      const role = await lockOrgSpaceRole(
        tx,
        orgId,
        personalSpaceRole.custom_role_id,
        "personal_space_role.custom_role_id",
      );
      defaultRole = { personalSpacePresetRole: null, personalSpaceRoleId: role.id };
    }
    const [updated] = await tx
      .update(organizations)
      .set({ orgSettings: merged, ...defaultRole, updatedAt: new Date() })
      .where(eq(organizations.id, orgId))
      .returning({
        orgSettings: organizations.orgSettings,
        personalSpacePresetRole: organizations.personalSpacePresetRole,
        personalSpaceRoleId: organizations.personalSpaceRoleId,
      });
    return updated;
  });

  // The transaction has committed, so the row is durable by the time the pin
  // entry is dropped — the next cached read cannot re-cache the pre-update value.
  orgApiVersionCache.invalidate(orgId);

  return toOrgSettings(row);
}

export async function getOrgMembers(orgId: string) {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(organizationMembers.joinedAt);

  if (rows.length === 0) return [];

  // Fetch display names and emails
  const userIds = rows.map((m) => m.userId);
  const [profileRows, userRows] = await Promise.all([
    db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, userIds)),
    db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, userIds)),
  ]);

  const profileMap = new Map(profileRows.map((p) => [p.id, p.displayName]));
  const emailMap = new Map(userRows.map((u) => [u.id, u.email]));

  return rows.map((row) => ({
    ...row,
    displayName: profileMap.get(row.userId) ?? undefined,
    email: emailMap.get(row.userId) ?? undefined,
  }));
}

/**
 * The one unlocked reader of `org_members` for a `(org, user)` pair. Every
 * caller that needs a role goes through it — `lockedActorRole` included, under
 * the ownership lock; the membership writes lock the target with `lockOrgMember`.
 *
 * `tx` is not a convenience: an invitation accept inserts the membership row
 * and the space rows in one transaction, so the read that follows must see its
 * own write.
 */
export async function getOrgMember(orgId: string, userId: string, tx: DbOrTx = db) {
  // Doors pass caller-supplied ids: a non-UUID is never a member row, and
  // comparing it to the uuid column raises 22P02, a 500 instead of "not a member".
  if (!isUuid(orgId)) return null;
  const [row] = await tx
    .select()
    .from(organizationMembers)
    .where(
      scopedWhere(organizationMembers, {
        orgId,
        extra: [eq(organizationMembers.userId, userId)],
      }),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Single-member counterpart to {@link getOrgMembers}: returns one member row
 * enriched with the same `displayName` + `email` fields the list endpoint
 * exposes, so a mutation handler can echo the full member DTO without a
 * follow-up GET. Returns null when the user is not a member of the org.
 */
export async function getOrgMemberWithProfile(orgId: string, userId: string) {
  const member = await getOrgMember(orgId, userId);
  if (!member) return null;

  const [profileRow, userRow] = await Promise.all([
    db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1),
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1),
  ]);

  return {
    ...member,
    displayName: profileRow[0]?.displayName ?? undefined,
    email: userRow[0]?.email ?? undefined,
  };
}

/**
 * Make `userId` a member of `orgId` — the membership row AND their personal
 * space, in the caller's transaction.
 *
 * THE membership door. Every path that creates one goes through it (org
 * creation via `provisionOrg`, invitation accept, OIDC auto-provision,
 * bootstrap), because a member without their personal space has nowhere
 * private to work and nothing to receive a share into (RBAC spec §3.6). There
 * is deliberately no bare-insert variant to reach for.
 *
 * ON CONFLICT DO NOTHING makes the membership half idempotent AND
 * transaction-safe. A plain INSERT that hits the (org_id, user_id) PK would
 * raise — and inside an enclosing transaction a raised statement ABORTS the
 * whole transaction, so a caught-and-swallowed error would still poison the
 * surrounding tx. The conflict clause turns "already a member" into a clean
 * no-op (the existing row, and its role, are left untouched — no silent
 * downgrade), and the space half is idempotent for its own reasons, so
 * re-provisioning an existing member is safe.
 *
 * Only an account of the `platform` realm becomes a member (`isPlatformAccount`):
 * `403 not_a_platform_account` otherwise.
 */
export async function provisionMember(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  userId: string,
  role: OrgRole = "member",
): Promise<{ created: boolean }> {
  if (!(await isPlatformAccount(tx, userId))) {
    throw new ApiError({
      status: 403,
      code: "not_a_platform_account",
      title: "Forbidden",
      detail: "This account belongs to an application of a space and cannot join an organization.",
    });
  }
  const inserted = await tx
    .insert(organizationMembers)
    .values({ orgId, userId, role })
    .onConflictDoNothing()
    .returning({ orgId: organizationMembers.orgId });
  if (!(await ensurePersonalSpace(tx, orgId, userId))) {
    throw notFound("Organization member not found");
  }
  // `created: false` is how a caller tells the LOSER of a concurrent-provision
  // race from a winner — the OIDC auto-join needs it, and re-reading the row
  // could not answer it.
  return { created: inserted.length > 0 };
}

interface MemberActor {
  userId: string;
  /** `authMethod === "session"`: the dashboard, not a token acting for the user. */
  firstPartySession: boolean;
}

/** What an exit revoked, for the `org.member_removed` / `org.member_left` audit. */
interface MemberExitResult {
  orphanedSpaceIds: string[];
  revokedApiKeyIds: string[];
  unsharedShares: ConnectionShare[];
  deletedModelCredentialIds: string[];
}

/** Under {@link lockOrganizationRow}, which all role writers take — not the request's role. */
async function lockedActorRole(
  executor: DbOrTx,
  orgId: string,
  actor: MemberActor,
): Promise<OrgRole> {
  const row = await getOrgMember(orgId, actor.userId, executor);
  if (!row) throw forbidden("Not a member of this organization");
  return row.role;
}

// Any token — a self-registered MCP client resolves as the user — can be driven
// by a prompt-injected agent; handing the org over takes the dashboard.
function assertOwnerChangeInSession(actor: MemberActor): void {
  if (!actor.firstPartySession) {
    throw forbidden("Granting or changing the owner role requires signing in to the dashboard");
  }
}

async function assertAnotherOwnerRemains(tx: Tx, orgId: string, userId: string): Promise<void> {
  const [row] = await tx
    .select({ owners: count() })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.role, "owner"),
        ne(organizationMembers.userId, userId),
      ),
    );
  if ((row?.owners ?? 0) === 0) {
    throw conflict(
      "last_owner",
      "An organization must keep at least one owner. Promote another member to owner first, or delete the organization.",
    );
  }
}

/** The member's armed schedules in `orgId`: the ones an exit disables `actor_left_org`. */
function armedSchedulesOf(orgId: string, userId: string): SQL {
  return and(
    eq(schedules.orgId, orgId),
    eq(schedules.userId, userId),
    eq(schedules.enabled, true),
  )!;
}

type ExitDisableCause = Extract<ScheduleDisabledReason, "actor_left_org" | "connection_unshared">;

/**
 * The schedules {@link removeMemberInTx} would disable for `userId`'s exit, and why, read from the
 * same selectors without writing: `connection_unshared` for another actor's schedule naming a
 * share the exit withdraws, `actor_left_org` for the member's own. A snapshot, stale once returned.
 */
async function exitScheduleDisables(
  executor: DbOrTx,
  orgId: string,
  userId: string,
): Promise<Map<string, ExitDisableCause>> {
  // Every share of the member's connections, as the exit sees them with the membership gone.
  const lost = await sharesLostIn(executor, { orgId, userId }, userId);
  const foreign = await selectForeignNamingScheduleIds(
    executor,
    // The scope filters on the connection's `user_id`: its owner is the member.
    lost.map((share) => ({
      id: share.connectionId,
      owner: { type: "user", id: userId },
      inSpaceId: share.spaceId,
    })),
  );
  const own = await executor
    .select({ id: schedules.id })
    .from(schedules)
    .where(armedSchedulesOf(orgId, userId));
  const causes = new Map<string, ExitDisableCause>();
  for (const id of foreign) causes.set(id, "connection_unshared");
  for (const { id } of own) causes.set(id, "actor_left_org");
  return causes;
}

/** The one exit door: leave and removal clean up the membership in one place. */
async function removeMemberInTx(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<MemberExitResult & { disabledScheduleIds: string[] }> {
  await tx.delete(organizationMembers).where(
    scopedWhere(organizationMembers, {
      orgId,
      extra: [eq(organizationMembers.userId, userId)],
    }),
  );

  // No FK on the polymorphic recipient, and runs (their source) stay as history.
  await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.recipientType, "user"),
        eq(notifications.recipientId, userId),
      ),
    );
  await tx
    .delete(runReads)
    .where(
      and(
        eq(runReads.orgId, orgId),
        eq(runReads.recipientType, "user"),
        eq(runReads.recipientId, userId),
      ),
    );

  // A personal model credential is the member's own money and serves only them: it
  // goes with the membership. Organization credentials stay (they are not owned by anyone).
  const deletedModelCredentials = await tx
    .delete(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.ownerUserId, userId)],
      }),
    )
    .returning({ id: modelProviderCredentials.id });
  await tx
    .delete(modelProviderPairings)
    .where(and(eq(modelProviderPairings.orgId, orgId), eq(modelProviderPairings.userId, userId)));

  // Neither these rows nor the keys and tokens below cascade from the membership,
  // and all of them would silently come back to life on a re-invite.
  await deleteSpaceMembershipsInOrg(tx, orgId, userId);

  const revokedKeys = await tx
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.createdBy, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  // Tokens that grant only this org: its own clients' (a refresh through an
  // `allowSignup` one re-provisions the member), deleted outright, and its MCP
  // endpoints' (the org's or a space's), withdrawn from tokens that may also
  // cover another org's. Deleted, never marked revoked: see
  // `oauth-token-revocation.ts`. A JWT lives until its TTL, stopped by the
  // per-request membership check and the grant's watermark.
  await endOAuthAccessInOrg(tx, orgId, userId);

  // Not deleted: 30 days to convert it, or to hand it back on re-invite (spec §3.6).
  const orphanedSpaceIds = await orphanPersonalSpaces(tx, orgId, userId);
  // The member's own armed schedules are disabled, not deleted (org history): they would keep
  // firing under the departed identity, whose user row survives (CRIT-13).
  const departedSchedules = armedSchedulesOf(orgId, userId);
  // No space lock needed, unlike a role change: with the membership gone the owner reaches no
  // space whatever a concurrent close leaves, so this unshares every shared connection. A close
  // unsharing the same rows is ordered against this by the row locks the unshare takes, which
  // cover the member's schedules too, in the same id-ordered statement.
  const unshared = await unshareConnectionsOfOwnersWithoutAccess(
    tx,
    { orgId, userId, stopSharingAllSpaces: true },
    departedSchedules,
  );
  const disabled = await tx
    .update(schedules)
    .set({
      enabled: false,
      disabledReason: "actor_left_org",
      nextRunAt: null,
      updatedAt: nextScheduleVersion,
    })
    .where(departedSchedules)
    .returning({ id: schedules.id });

  return {
    orphanedSpaceIds,
    revokedApiKeyIds: revokedKeys.map((row) => row.id),
    unsharedShares: unshared.shares,
    deletedModelCredentialIds: deletedModelCredentials.map((row) => row.id),
    disabledScheduleIds: [...unshared.disabledScheduleIds, ...disabled.map((row) => row.id)],
  };
}

/** `authorize` judges rows read under the lock: no role write lands before the delete. */
async function exitOrg(
  orgId: string,
  userId: string,
  authorize: (tx: Tx, role: OrgRole) => Promise<void>,
): Promise<MemberExitResult> {
  const { disabledScheduleIds, ...result } = await db.transaction(async (tx) => {
    await lockOrganizationRow(tx, orgId);
    const member = await lockOrgMember(tx, orgId, userId);
    if (!member) throw notFound("Member not found");
    await authorize(tx, member.role);
    // Runs on every exit; only a leave can fail it (an owner is removed only by another owner).
    if (member.role === "owner") await assertAnotherOwnerRemains(tx, orgId, userId);
    return removeMemberInTx(tx, orgId, userId);
  });
  // Cached resolutions may still carry the removed member's personal credentials.
  clearResolvedModelCache();

  // Outside the transaction, best-effort: a surviving job's fire finds its row disabled.
  await removeScheduleJobs(disabledScheduleIds);
  await emitEvent("onOrgMemberRemove", orgId, userId);
  return result;
}

/**
 * Remove `targetUserId` on `actor`'s authority. 404 when not a member; 403 when
 * the actor is not a member, `canRemoveMember` refuses, or the target is an
 * owner and the actor is not in a dashboard session.
 *
 * @returns what the removal orphaned and revoked, for `org.member_removed`.
 */
export async function removeMember(
  orgId: string,
  targetUserId: string,
  actor: MemberActor,
): Promise<MemberExitResult> {
  return exitOrg(orgId, targetUserId, (tx, targetRole) =>
    assertMayRemove(tx, orgId, targetUserId, targetRole, actor),
  );
}

/** 403 unless `actor` may remove `targetUserId` (of `targetRole`): the removal's own rule. */
async function assertMayRemove(
  executor: DbOrTx,
  orgId: string,
  targetUserId: string,
  targetRole: OrgRole,
  actor: MemberActor,
): Promise<void> {
  const actorRole = await lockedActorRole(executor, orgId, actor);
  const isSelf = targetUserId === actor.userId;
  if (!canRemoveMember({ actorRole, targetRole, isSelf })) {
    throw forbidden("You cannot remove this member");
  }
  if (targetRole === "owner") assertOwnerChangeInSession(actor);
}

/** One schedule a member's removal would stop in a team space, as `getMemberDepartureImpact` lists it. */
export interface DepartureImpactItem {
  id: string;
  name: string | null;
  space: { id: string; name: string };
  packageId: string;
  actor: { type: "user" | "end_user"; id: string; name: string | null };
  cause: ExitDisableCause;
  /** Integrations whose named connection is the departing member's: reassigning is not enough. */
  lost_integrations: string[];
}

/**
 * What removing `targetUserId` would stop in the org's TEAM spaces, on `actor`'s authority: the
 * schedules {@link removeMember} disables there, read without writing (a snapshot). 404 when not a
 * member, 403 on the removal's own rule. Personal-space schedules are left out: the space enters
 * its 30-day window, and an admin cannot read a live one.
 */
export async function memberDepartureImpact(
  orgId: string,
  targetUserId: string,
  actor: MemberActor,
): Promise<DepartureImpactItem[]> {
  const target = await getOrgMember(orgId, targetUserId);
  if (!target) throw notFound("Member not found");
  await assertMayRemove(db, orgId, targetUserId, target.role, actor);

  const causes = await exitScheduleDisables(db, orgId, targetUserId);
  if (causes.size === 0) return [];
  const rows = await db
    .select({
      id: schedules.id,
      name: schedules.name,
      packageId: schedules.packageId,
      userId: schedules.userId,
      endUserId: schedules.endUserId,
      connectionOverrides: schedules.connectionOverrides,
      spaceId: spaces.id,
      spaceName: spaces.name,
    })
    .from(schedules)
    .innerJoin(spaces, eq(spaces.id, schedules.spaceId))
    .where(
      and(
        eq(schedules.orgId, orgId),
        inArray(schedules.id, [...causes.keys()]),
        isNull(spaces.ownerUserId),
      ),
    )
    .orderBy(asc(spaces.name), asc(schedules.name), asc(schedules.id));
  if (rows.length === 0) return [];

  const owned = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.userId, targetUserId)),
    );
  const ownedIds = new Set(owned.map((row) => row.id));
  const userIds = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
  const [userNames, endUserNames] = await Promise.all([
    batchLoadUserNames(userIds),
    batchLoadScheduleEndUserNames(orgId, rows),
  ]);

  return rows.map((row) => {
    const actorRef = actorFromIds(row.userId, row.endUserId)!;
    return {
      id: row.id,
      name: row.name,
      space: { id: row.spaceId, name: row.spaceName },
      packageId: row.packageId,
      actor: {
        ...actorRef,
        name:
          (actorRef.type === "user" ? userNames.get(actorRef.id) : endUserNames.get(row.id)) ??
          null,
      },
      cause: causes.get(row.id)!,
      lost_integrations: integrationsNamingAny(row.connectionOverrides, ownedIds),
    };
  });
}

/** The member leaves — the removal's exit. 404 when not a member, 409 `last_owner`. */
export async function leaveOrganization(orgId: string, userId: string): Promise<MemberExitResult> {
  return exitOrg(orgId, userId, async () => {});
}

/**
 * Change `targetUserId`'s role on `actor`'s authority. 404 when not a member;
 * 403 when the actor is not a member, `assignableRolesForMember` does not offer
 * `role`, or owner is granted or taken outside a dashboard session.
 *
 * @returns the previous role, the space grants the promotion revoked and the
 *   connection shares the demotion withdrew, for the audit.
 */
export async function updateMemberRole(
  orgId: string,
  targetUserId: string,
  role: OrgRole,
  actor: MemberActor,
): Promise<{
  previousRole: OrgRole;
  revoked: RevokedSpaceAssignment[];
  unsharedShares: ConnectionShare[];
  /** The member's personal-space override a promotion to owner or admin dropped, if any. */
  personalSpaceRoleCleared: SpaceRoleColumns | null;
}> {
  const { disabledScheduleIds, ...result } = await db.transaction(async (tx) => {
    await lockOrganizationRow(tx, orgId);
    const target = await lockOrgMember(tx, orgId, targetUserId);
    if (!target) throw notFound("Member not found");
    const assignable = assignableRolesForMember({
      actorRole: await lockedActorRole(tx, orgId, actor),
      targetRole: target.role,
      isSelf: targetUserId === actor.userId,
    });
    if (!assignable.includes(role)) {
      throw forbidden("You cannot assign this role to this member");
    }
    if (role === "owner" || target.role === "owner") assertOwnerChangeInSession(actor);

    await tx
      .update(organizationMembers)
      .set({ role })
      .where(
        scopedWhere(organizationMembers, {
          orgId,
          extra: [eq(organizationMembers.userId, targetUserId)],
        }),
      );
    // Unread by an owner or admin. Dropped first, so `revoked` never lists the personal space.
    const personalSpaceRoleCleared =
      role === "owner" || role === "admin"
        ? await deletePersonalSpaceOverride(tx, orgId, targetUserId)
        : null;
    // An admin/owner's explicit space rows are unreadable (the org role answers
    // first) and would silently restore on a later demotion (RBAC spec §3.2).
    const revoked =
      role === "owner" || role === "admin"
        ? await deleteSpaceMembershipsInOrg(tx, orgId, targetUserId)
        : [];
    // A demotion drops the implicit reach of the org role (admin → member,
    // member → guest on open spaces). Member row (above), then the spaces: see `lockSpaceRow`.
    await lockSpacesOfSharedConnections(tx, orgId, targetUserId);

    const unshared = await unshareConnectionsOfOwnersWithoutAccess(tx, {
      orgId,
      userId: targetUserId,
      stopSharingAllSpaces: role !== "owner" && role !== "admin",
    });
    return {
      previousRole: target.role,
      revoked,
      unsharedShares: unshared.shares,
      personalSpaceRoleCleared,
      disabledScheduleIds: unshared.disabledScheduleIds,
    };
  });
  await removeScheduleJobs(disabledScheduleIds);
  return result;
}

/** The org's `personal_space_role` decoded, before the floor and the guest cap. */
export async function getOrgPersonalSpaceDefault(orgId: string): Promise<SpaceRoleRef> {
  const [row] = await db
    .select(PERSONAL_SPACE_DEFAULT_COLUMNS)
    .from(organizations)
    .leftJoin(psr, personalSpaceDefaultOn)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) throw notFound("Organization not found");
  return personalSpaceDefaultRef(row);
}

/** Delete `userId`'s personal-space override; returns its role, `null` when there was none. */
async function deletePersonalSpaceOverride(
  tx: Pick<typeof db, "select" | "delete">,
  orgId: string,
  userId: string,
): Promise<SpaceRoleColumns | null> {
  const deleted = await tx
    .delete(spaceMembers)
    .where(
      and(
        eq(spaceMembers.userId, userId),
        inArray(
          spaceMembers.spaceId,
          tx
            .select({ id: spaces.id })
            .from(spaces)
            .where(and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId))),
        ),
      ),
    )
    .returning({ presetRole: spaceMembers.presetRole, customRoleId: spaceMembers.customRoleId });
  return deleted[0] ?? null;
}

/**
 * Set or clear (`null`) `targetUserId`'s personal-space override (RBAC spec §3.6), under their
 * `org_members` lock so a promotion serializes with it. Returns the previous role, for the audit.
 */
export async function setPersonalSpaceRoleOverride(
  orgId: string,
  targetUserId: string,
  assignment: SpaceRoleAssignment | null,
  addedBy: string,
): Promise<{ previous: SpaceRoleColumns | null }> {
  return db.transaction(async (tx) => {
    const target = await lockOrgMember(tx, orgId, targetUserId);
    if (!target) throw notFound("Member not found");
    if (assignment === null) {
      return { previous: await deletePersonalSpaceOverride(tx, orgId, targetUserId) };
    }
    if (target.role === "owner" || target.role === "admin") {
      throw conflict(
        "redundant_space_role",
        `${target.role}s always hold admin in their own personal space; an override would grant nothing`,
      );
    }
    const values: SpaceRoleColumns =
      "preset_role" in assignment
        ? { presetRole: assignment.preset_role, customRoleId: null }
        : {
            presetRole: null,
            customRoleId: (await lockOrgSpaceRole(tx, orgId, assignment.custom_role_id)).id,
          };
    const space = await ensurePersonalSpace(tx, orgId, targetUserId);
    if (!space) throw notFound("Member not found");
    const [existing] = await tx
      .select({ presetRole: spaceMembers.presetRole, customRoleId: spaceMembers.customRoleId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, targetUserId)))
      .limit(1);
    await tx
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: targetUserId, addedBy, ...values })
      .onConflictDoUpdate({ target: [spaceMembers.spaceId, spaceMembers.userId], set: values });
    return { previous: existing ?? null };
  });
}

/** Each member's override of the org's `personal_space_role`, keyed by user id; absent = none. */
export async function listPersonalSpaceRoleOverrides(
  orgId: string,
  userIds?: readonly string[],
): Promise<Map<string, SpaceRoleAssignment>> {
  if (userIds?.length === 0) return new Map();
  const rows = await db
    .select({
      userId: spaceMembers.userId,
      presetRole: spaceMembers.presetRole,
      customRoleId: spaceMembers.customRoleId,
    })
    .from(spaceMembers)
    .innerJoin(
      spaces,
      and(eq(spaces.id, spaceMembers.spaceId), eq(spaces.ownerUserId, spaceMembers.userId)),
    )
    .where(
      and(
        eq(spaces.orgId, orgId),
        userIds === undefined ? undefined : inArray(spaceMembers.userId, [...userIds]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.userId,
      row.presetRole !== null
        ? { preset_role: row.presetRole }
        : { custom_role_id: row.customRoleId! },
    ]),
  );
}

/**
 * The enabled schedules `candidate` as the org's `personal_space_role` would stop (RBAC spec §3.6):
 * those members and guests on the default run in their own personal space, left without
 * `agents:run`. An unlocked snapshot.
 */
export async function personalSpaceRoleImpact(
  orgId: string,
  candidate: SpaceRoleAssignment,
): Promise<{ schedules: number; members: number }> {
  const ref: SpaceRoleRef =
    "preset_role" in candidate
      ? { kind: "preset", preset: candidate.preset_role }
      : {
          kind: "custom",
          role: await lockOrgSpaceRole(db, orgId, candidate.custom_role_id, "custom_role_id"),
        };

  const stoppedRoles = (["member", "guest"] as const).filter(
    (orgRole) => !spacePermissions(defaultPersonalSpaceRole(orgRole, ref)).has("agents:run"),
  );
  if (stoppedRoles.length === 0) return { schedules: 0, members: 0 };

  const [row] = await db
    .select({ schedules: count(schedules.id), members: countDistinct(spaces.ownerUserId) })
    .from(schedules)
    .innerJoin(
      spaces,
      and(
        eq(spaces.id, schedules.spaceId),
        eq(spaces.ownerUserId, schedules.userId),
        isNull(spaces.orphanedAt),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, spaces.orgId),
        eq(organizationMembers.userId, spaces.ownerUserId),
      ),
    )
    // No override row = on the default.
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, spaces.ownerUserId)),
    )
    .where(
      and(
        eq(schedules.orgId, orgId),
        eq(spaces.orgId, orgId),
        eq(schedules.enabled, true),
        inArray(organizationMembers.role, stoppedRoles),
        isNull(spaceMembers.userId),
      ),
    );
  return { schedules: row?.schedules ?? 0, members: row?.members ?? 0 };
}

/** An expected refusal: no `cause`, so the error handler writes no error line. */
function orgHasActiveRuns(): ApiError {
  return new ApiError({
    status: 400,
    code: "delete_failed",
    title: "Bad Request",
    detail: "Cannot delete organization: runs are in progress",
  });
}

/**
 * Reserve the deletion of this organization.
 *
 * MUST be awaited by callers BEFORE anything observes the deletion —
 * concretely, before the route emits `onOrgDelete`. The ordering is
 * load-bearing and irreversible if inverted: module handlers on that event
 * perform destructive, non-transactional work outside our database (the billing
 * module drains billing then CANCELS the Stripe subscription and drops the
 * billing account; the mcp module drops the org from the RFC 8707 audience
 * allowlist). If `deleteOrganization` then throws — which it does, from inside
 * its transaction, when runs are in progress — the org row survives but comes
 * back stripped of everything the handlers tore down, and no repair path can
 * rebuild it (the debt is summed over rows that were just deleted, and a
 * consumed free-tier claim does not come back). So: refuse first, notify
 * second, delete third.
 *
 * The check and the stamp commit TOGETHER under the per-org advisory key
 * `createRun` takes, so no run can be admitted behind the modules' back.
 * Idempotent: a standing reservation is the state a retried DELETE finds.
 *
 * Refuses with the same {@link orgHasActiveRuns} the transaction raises.
 */
export async function reserveOrgDeletion(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${orgRunConcurrencyLockKey(orgId)})::bigint)`,
    );

    const [org] = await tx
      .select({ id: organizations.id, deletingAt: organizations.deletingAt })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!org) throw new Error("Failed to delete organization: not found");

    if ((await countInProgressRuns(tx, { orgId })) > 0) {
      throw orgHasActiveRuns();
    }

    if (org.deletingAt) return;
    await tx
      .update(organizations)
      .set({ deletingAt: new Date() })
      .where(eq(organizations.id, orgId));
  });
}

export async function deleteOrganization(orgId: string): Promise<void> {
  // Delete in FK-safe order within a transaction.
  await db.transaction(async (tx) => {
    // Serialize against concurrent run admission. `createRun` acquires this
    // same per-org advisory lock before its count + INSERT. Taking it here
    // means a run admitted after our snapshot below cannot commit until this
    // transaction finishes — closing the TOCTOU window where a run that
    // started after the count but before the delete would be cascade-deleted
    // mid-flight. Released automatically at transaction end.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${orgRunConcurrencyLockKey(orgId)})::bigint)`,
    );

    // Lock the parent before enumerating cascade-owned children. Concurrent
    // FK inserts then either commit before this snapshot or wait until the
    // organization is gone; no child can disappear without an outbox job.
    const [lockedOrg] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!lockedOrg) throw new Error("Failed to delete organization: not found");

    if ((await countInProgressRuns(tx, { orgId })) > 0) {
      throw orgHasActiveRuns();
    }

    // Enumerate every storage object this org owns BEFORE the FK cascade drops
    // the rows, and enqueue its physical deletion into the transactional outbox
    // (same transaction). Without this the cascade would silently orphan the
    // org's files / uploads / run-workspace / package objects in S3/FS. The
    // worker expands each run manifest into its file keys and deletes the
    // manifest last, so this transaction does no storage I/O and cleanup remains
    // replayable. (Queries are sequential — a Drizzle tx multiplexes one
    // connection, so concurrent queries on `tx` are unsafe.)
    const docRows = await tx
      .select({ storageKey: files.storageKey })
      .from(files)
      .where(eq(files.orgId, orgId));
    const uploadRows = await tx
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.orgId, orgId));
    const runRows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.orgId, orgId));

    const storageJobs: StorageDeletionJobInput[] = [];
    for (const r of [...docRows, ...uploadRows]) {
      const [bucket, ...rest] = r.storageKey.split("/");
      if (bucket && rest.length > 0)
        storageJobs.push({ bucket, storageKey: rest.join("/"), reason: "org_deleted" });
    }
    for (const r of runRows) storageJobs.push(...runWorkspaceDeletionJobs(r.id, "org_deleted"));
    // `agent-packages` (published version ZIPs) + `library-packages` (draft
    // item ZIPs) — enumerated from the rows `tx.delete(packages)` below is
    // about to drop. Ownership comes from `packages.org_id`, which is why this
    // cannot purge another org's or the system catalog's artifacts even though
    // `agent-packages` keys are not org-prefixed (see the module doc).
    storageJobs.push(...(await orgPackageStorageDeletionJobs(tx, orgId, "org_deleted")));
    await enqueueStorageDeletion(tx, storageJobs);

    // run_logs → runs (cascade exists, but org_id FK needs manual delete)
    await tx.delete(runLogs).where(eq(runLogs.orgId, orgId));
    await tx.delete(runs).where(eq(runs.orgId, orgId));
    // Org-scoped tables (package_schedules, org_models, model_provider_credentials,
    // and module-owned tables like webhooks) cascade via their orgId FK —
    // no explicit delete needed.
    // spacePackages cascade through spaces → orgId
    await tx.delete(packages).where(eq(packages.orgId, orgId));
    // integration_connections cascade through spaces → orgId — no explicit delete needed
    await tx.delete(orgInvitations).where(eq(orgInvitations.orgId, orgId));
    // org_members cascades from organizations (onDelete: "cascade")

    const deleted = await tx
      .delete(organizations)
      .where(eq(organizations.id, orgId))
      .returning({ id: organizations.id });
    if (deleted.length === 0) {
      throw new Error("Failed to delete organization: not found");
    }
  });

  // Hygiene, not a confinement boundary: a cached pin for a deleted org is
  // inert (membership is gone, org-context 403s), but it need not linger.
  orgApiVersionCache.invalidate(orgId);
}
