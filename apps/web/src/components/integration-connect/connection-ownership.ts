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
 * The write controls a connection row offers, as the API enforces them (every write needs
 * `integrations:connect`): rename is the owner's or a governor's; sharing is the owner's
 * consent, a governor only withdraws one. A `locked` row refuses an unshare (409
 * `connection_pinned`): the toggle stays, disabled.
 */
export function connectionRowGrants(args: {
  isOwn: boolean;
  isShared: boolean;
  canConnect: boolean;
  canConfigure: boolean;
  locked: boolean;
}): { canRename: boolean; canToggleShare: boolean; shareLocked: boolean } {
  const canRename = args.canConnect && (args.isOwn || args.canConfigure);
  return {
    canRename,
    canToggleShare: (args.isOwn && args.canConnect) || (args.isShared && canRename),
    shareLocked: args.locked && args.isShared,
  };
}
