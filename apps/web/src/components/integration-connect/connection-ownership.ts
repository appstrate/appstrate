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
