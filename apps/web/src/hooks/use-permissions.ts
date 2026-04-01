import { useOrg } from "./use-org.ts";
import type { OrgRole } from "@appstrate/shared-types";

/** i18n key for a role label: `orgSettings.roleOwner`, etc. */
const ROLE_I18N_KEY: Record<OrgRole, string> = {
  owner: "orgSettings.roleOwner",
  admin: "orgSettings.roleAdmin",
  member: "orgSettings.roleMember",
  viewer: "orgSettings.roleViewer",
};

/** Get the i18n key for a role label. */
export function roleI18nKey(role: string): string {
  return ROLE_I18N_KEY[role as OrgRole] ?? role;
}

/** Assignable roles for invitations (excludes owner). */
export const INVITE_ROLES = ["viewer", "member", "admin"] as const;

/** All roles including owner (for member role change by owner). */
export const ALL_ROLES = ["viewer", "member", "admin", "owner"] as const;

/**
 * Role-based permission helpers for UI gating.
 *
 * Uses the role hierarchy to determine access levels.
 * The actual enforcement is server-side — this only controls UI visibility.
 */
export function usePermissions() {
  const { currentOrg } = useOrg();
  const role: OrgRole | null = currentOrg?.role ?? null;

  const isOwner = role === "owner";
  const isAdmin = role === "admin" || isOwner;
  const isMember = role === "member" || isAdmin;

  return { role, isOwner, isAdmin, isMember };
}
