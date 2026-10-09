// SPDX-License-Identifier: Apache-2.0

interface ConnectionOwnerFields {
  owner_type: "user" | "end_user";
  owner_id: string;
}

/**
 * Whether a connection belongs to the signed-in dashboard user. The lists include rows shared
 * by others; only the (type, id) pair identifies the owner.
 */
export function isConnectionOwnedBy(c: ConnectionOwnerFields, userId: string | undefined): boolean {
  return c.owner_type === "user" && !!userId && c.owner_id === userId;
}

/** The `settings` key saying why a locked connection refuses an unshare or delete; null unlocked. */
export function connectionLockHintKey(lockedBy: "admin_pin" | "org_default" | null | undefined) {
  if (!lockedBy) return null;
  return lockedBy === "admin_pin"
    ? "integration.connection.lock.adminPin"
    : "integration.connection.lock.orgDefault";
}

/**
 * The write controls a connection row offers in the current space, as the API enforces them
 * (every write needs `integrations:connect`). Sharing is the owner's consent: only the owner
 * edits the target spaces; a governor (`integrations:configure`) only withdraws a colleague's
 * row from this space. Rename is the owner's, or a governor's on a space-scoped row (it lives
 * here); an org-scoped row spans spaces, so a governor renaming it is refused (403).
 */
export function connectionRowGrants(args: {
  isOwn: boolean;
  isShared: boolean;
  scope: "org" | "space";
  canConnect: boolean;
  canConfigure: boolean;
}): { canRename: boolean; canEditShares: boolean; canUnshareHere: boolean } {
  const governs = args.canConnect && args.canConfigure && !args.isOwn;
  return {
    canRename: args.canConnect && (args.isOwn || (governs && args.scope === "space")),
    canEditShares: args.canConnect && args.isOwn,
    canUnshareHere: governs && args.isShared,
  };
}

/**
 * Whether the row is shared into `spaceId`. An owner's row lists every space it is shared
 * into; anyone else's lists only the current one, when shared here.
 */
export function isSharedInSpace(c: { shared_space_ids: string[] }, spaceId: string | null) {
  return !!spaceId && c.shared_space_ids.includes(spaceId);
}

/** The `shared_space_ids` a PATCH sends (it replaces the set) to share into or out of `spaceId`. */
export function withSpaceShare(ids: string[], spaceId: string, shared: boolean): string[] {
  const rest = ids.filter((id) => id !== spaceId);
  return shared ? [...rest, spaceId] : rest;
}

/**
 * The spaces an owner may pick as share targets: those of the org they are a member of. A
 * personal space has no one to share with, so it is offered only while already a target, to be
 * removed.
 */
export function shareTargetSpaces<S extends { id: string; access: string; personal: boolean }>(
  spaces: readonly S[],
  sharedSpaceIds: readonly string[],
): S[] {
  return spaces.filter(
    (s) => s.access === "member" && (!s.personal || sharedSpaceIds.includes(s.id)),
  );
}
