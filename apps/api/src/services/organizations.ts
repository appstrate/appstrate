// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { conflict, forbidden, notFound } from "../lib/errors.ts";
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
  schedules,
  files,
  uploads,
  apiKeys,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
} from "@appstrate/db/schema";
import {
  and,
  arrayContains,
  eq,
  ne,
  inArray,
  isNull,
  notInArray,
  or,
  count,
  sql,
} from "drizzle-orm";
import type { OrgRole } from "../types/index.ts";
import { scopedWhere, type DbOrTx, type Tx } from "../lib/db-helpers.ts";
import { countInProgressRuns, orgRunConcurrencyLockKey } from "./state/runs.ts";
import { removeScheduleJobs } from "./scheduler.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { runWorkspaceDeletionJobs } from "./run-workspace-storage.ts";
import { orgPackageStorageDeletionJobs } from "./package-storage-deletion.ts";
import { orgApiVersionCache } from "./org-settings-cache.ts";
import { deleteSpaceMembershipsInOrg, lockOrgMember } from "./space-members.ts";
import { orphanPersonalSpaces } from "./spaces.ts";
import { ensurePersonalSpace, provisionOrg } from "@appstrate/db/provision-org";
import type { RevokedSpaceAssignment } from "./space-members.ts";
import { assignableRolesForMember, canRemoveMember } from "@appstrate/shared-types";
import { getMcpOrgResourceUri } from "../lib/audiences.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";

interface OrgResult {
  id: string;
  name: string;
  slug: string;
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
    createdBy: row.createdBy ?? "",
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
    filesBytesUsed: row.filesBytesUsed,
    filesBytesLimit: row.filesBytesLimit,
    deletingAt: toISO(row.deletingAt),
  };
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
  const { org } = await db.transaction(async (tx) =>
    provisionOrg(tx, {
      name,
      slug,
      ownerUserId: userId,
      orgSettings: { api_version: CURRENT_API_VERSION },
    }),
  );

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
    );

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
  updates: { name?: string; slug?: string },
): Promise<OrgResult> {
  const [row] = await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  if (!row) throw new Error("Failed to update organization");
  return toOrgResult(row);
}

// Re-exporting `orgSettingsSchema` from here died with the second
// `.partial()`: the two readers it had now take the base straight from
// `@appstrate/core/permissions` or the patch schema below.
import { orgSettingsSchema as orgSettingsBaseSchema } from "@appstrate/core/permissions";

/**
 * Body of `PUT /api/orgs/{orgId}/settings` — a PATCH over the org settings
 * document, so every member is optional.
 *
 * `.strict()`: an unknown key is a 400, never a silently dropped setting. It
 * lives HERE rather than at the route because `openapi/zod-schema-registry.ts`
 * documents this body too, and it built its own `orgSettingsSchema.partial()`
 * — two expressions of one shape that could disagree.
 *
 * This is the ONLY place the shape is enforced, and it has to be: the base
 * schema in `@appstrate/core/permissions` never parses anything. It has
 * exactly two consumers — this `.partial().strict()` derivation, and the
 * `OrgSettings` type alias in `packages/shared-types` (`z.infer`, erased at
 * runtime). Nothing validates a stored row through it: `getOrgSettings` below
 * CASTS the JSONB column and returns it. So the base being a plain
 * `z.object()` is not a read-path affordance — a plain `z.object()` STRIPS
 * unknown keys rather than tolerating them, and would drop exactly the
 * newer-writer keys such a rationale would be protecting. Its strictness is
 * simply unobservable, and the closure that matters is the one on this line.
 * `test/integration/services/organizations.test.ts` pins both halves.
 */
export const orgSettingsPatchSchema = orgSettingsBaseSchema.partial().strict();
import type { OrgSettings } from "@appstrate/shared-types";

/**
 * Uncached, deliberately: the oidc `dashboard_sso_enabled` gate reads through
 * here and a security gate must not depend on a TTL. The one hot-path field
 * (the `api_version` pin) has its own cached reader below.
 */
export async function getOrgSettings(orgId: string): Promise<OrgSettings> {
  const [row] = await db
    .select({ orgSettings: organizations.orgSettings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return (row?.orgSettings as OrgSettings) ?? {};
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

export async function updateOrgSettings(
  orgId: string,
  updates: Partial<OrgSettings>,
): Promise<OrgSettings> {
  // Merge server-side via JSONB concatenation so concurrent admins toggling
  // different keys don't clobber each other (read-modify-write would race).
  const [row] = await db
    .update(organizations)
    .set({
      orgSettings: sql`COALESCE(${organizations.orgSettings}, '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId))
    .returning({ orgSettings: organizations.orgSettings });

  // The statement above is auto-committed (no enclosing transaction), so the
  // row is durable by the time the pin entry is dropped — the next cached
  // read cannot re-cache the pre-update value.
  orgApiVersionCache.invalidate(orgId);

  return (row?.orgSettings as OrgSettings) ?? {};
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
 */
export async function provisionMember(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  userId: string,
  role: OrgRole = "member",
): Promise<{ created: boolean }> {
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
}

/**
 * Serialises every write to the org's owner set. NO KEY UPDATE: child inserts
 * take FOR KEY SHARE on this row and must not queue behind a membership change.
 */
async function lockOrgOwnership(tx: Tx, orgId: string): Promise<void> {
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for("no key update");
  if (!org) throw notFound("Organization not found");
}

/** Under {@link lockOrgOwnership}, which all role writers take — not the request's role. */
async function lockedActorRole(tx: Tx, orgId: string, actor: MemberActor): Promise<OrgRole> {
  const row = await getOrgMember(orgId, actor.userId, tx);
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

  // Neither these rows nor the keys and tokens below cascade from the membership,
  // and all of them would silently come back to life on a re-invite.
  await deleteSpaceMembershipsInOrg(tx, orgId, userId);

  const revokedKeys = await tx
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.createdBy, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  // Tokens that grant only this org: its own clients' (a refresh through an
  // `allowSignup` one re-provisions the member) and those bound to its MCP
  // resource. Only opaque tokens are rows; a JWT lives until its TTL, stopped by
  // the per-request membership check.
  const orgClientIds = tx
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(and(eq(oauthClient.level, "org"), eq(oauthClient.referencedOrgId, orgId)));
  const mcpResource = [getMcpOrgResourceUri(orgId)];
  const revokedAt = new Date();
  await tx
    .update(oauthRefreshToken)
    .set({ revoked: revokedAt })
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        isNull(oauthRefreshToken.revoked),
        or(
          inArray(oauthRefreshToken.clientId, orgClientIds),
          arrayContains(oauthRefreshToken.resources, mcpResource),
        ),
      ),
    );
  await tx
    .update(oauthAccessToken)
    .set({ revoked: revokedAt })
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        isNull(oauthAccessToken.revoked),
        or(
          inArray(oauthAccessToken.clientId, orgClientIds),
          arrayContains(oauthAccessToken.resources, mcpResource),
        ),
      ),
    );

  // Not deleted: 30 days to convert it, or to hand it back on re-invite (spec §3.6).
  const orphanedSpaceIds = await orphanPersonalSpaces(tx, orgId, userId);

  // Disabled, not deleted (org history): they would keep firing under the
  // departed identity, whose user row survives (CRIT-13).
  const disabled = await tx
    .update(schedules)
    .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
    .where(
      and(eq(schedules.orgId, orgId), eq(schedules.userId, userId), eq(schedules.enabled, true)),
    )
    .returning({ id: schedules.id });

  return {
    orphanedSpaceIds,
    revokedApiKeyIds: revokedKeys.map((row) => row.id),
    disabledScheduleIds: disabled.map((row) => row.id),
  };
}

/** `authorize` judges rows read under the lock: no role write lands before the delete. */
async function exitOrg(
  orgId: string,
  userId: string,
  authorize: (tx: Tx, role: OrgRole) => Promise<void>,
): Promise<MemberExitResult> {
  const { disabledScheduleIds, ...result } = await db.transaction(async (tx) => {
    await lockOrgOwnership(tx, orgId);
    const member = await lockOrgMember(tx, orgId, userId);
    if (!member) throw notFound("Member not found");
    await authorize(tx, member.role);
    // Runs on every exit; only a leave can fail it (an owner is removed only by another owner).
    if (member.role === "owner") await assertAnotherOwnerRemains(tx, orgId, userId);
    return removeMemberInTx(tx, orgId, userId);
  });

  // Outside the transaction, best-effort; the scheduler revalidates the actor at fire time.
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
  return exitOrg(orgId, targetUserId, async (tx, targetRole) => {
    const actorRole = await lockedActorRole(tx, orgId, actor);
    const isSelf = targetUserId === actor.userId;
    if (!canRemoveMember({ actorRole, targetRole, isSelf })) {
      throw forbidden("You cannot remove this member");
    }
    if (targetRole === "owner") assertOwnerChangeInSession(actor);
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
 * @returns the previous role and the space grants the promotion revoked, for the audit.
 */
export async function updateMemberRole(
  orgId: string,
  targetUserId: string,
  role: OrgRole,
  actor: MemberActor,
): Promise<{ previousRole: OrgRole; revoked: RevokedSpaceAssignment[] }> {
  return db.transaction(async (tx) => {
    await lockOrgOwnership(tx, orgId);
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
    // An admin/owner's explicit space rows are unreadable (the org role answers
    // first) and would silently restore on a later demotion (RBAC spec §3.2).
    const revoked =
      role === "owner" || role === "admin"
        ? await deleteSpaceMembershipsInOrg(tx, orgId, targetUserId)
        : [];
    return { previousRole: target.role, revoked };
  });
}

/**
 * Reserve the deletion of this organization.
 *
 * MUST be awaited by callers BEFORE anything observes the deletion —
 * concretely, before the route emits `onOrgDelete`. The ordering is
 * load-bearing and irreversible if inverted: module handlers on that event
 * perform destructive, non-transactional work outside our database (the ee
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
 * Throws the same `Error` messages the transaction would, so the route maps
 * either failure onto the same `400 delete_failed` response.
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
      throw new Error("Cannot delete organization: runs are in progress");
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
      throw new Error("Cannot delete organization: runs are in progress");
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

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const result = await db
    .select({ slugCount: count() })
    .from(organizations)
    .where(eq(organizations.slug, slug));

  return (result[0]?.slugCount ?? 0) === 0;
}
