// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo } from "react";
import { useOrg } from "./use-org.ts";
import { useSpaces } from "./use-spaces.ts";
import { useCurrentSpaceId } from "./use-current-space.ts";
import type { OrgRole } from "@appstrate/shared-types";
import { ORG_ROLES_WITH_FULL_ACCESS, type CorePermission } from "@appstrate/core/permissions";

/**
 * A permission string `can()` accepts.
 *
 * Core's catalog is spelled out so editors autocomplete the vocabulary; the
 * open `string` arm keeps the module-contributed strings (`webhooks:read`,
 * `oauth-clients:write`, `chat:write`, `billing:read`, …) callable — they are
 * declared in each module's own package, which the SPA does not import.
 */
export type GateablePermission = CorePermission | (string & {});

/** i18n key for a role label: `orgSettings.roleOwner`, etc. */
const ROLE_I18N_KEY: Record<OrgRole, string> = {
  owner: "orgSettings.roleOwner",
  admin: "orgSettings.roleAdmin",
  member: "orgSettings.roleMember",
  guest: "orgSettings.roleGuest",
};

/** Get the i18n key for a role label. */
export function roleI18nKey(role: OrgRole): string {
  return ROLE_I18N_KEY[role];
}

/**
 * Who may preview a role — the server's own eligibility rule (`validateViewAs`).
 *
 * A role rather than a permission because that is what the server checks: the
 * preview is a downgrade of the caller's own authority, and "a preview only
 * removes" holds only while the previewer outranks every persona. The triggers
 * hide for anyone else; the server refuses them (`view_as_forbidden`) anyway.
 */
export function useCanPreviewRole(): boolean {
  const { orgRole } = usePermissions();
  return orgRole !== null && (ORG_ROLES_WITH_FULL_ACCESS as readonly OrgRole[]).includes(orgRole);
}

/**
 * Gate on the permissions of a package's HOME space, not the current one.
 *
 * Write authority over a package follows `packages.home_space_id` — the server
 * checks exactly that (`assertPackageMutationAccess`), so a button gated on the
 * space the reader happens to be in offers edits the API answers 403. A `null`
 * home is the organization catalog: owners and admins only.
 *
 * `null` and `undefined` are DIFFERENT answers here. Every package read emits
 * the field, so `null` is the organization catalog and `undefined` only means
 * the detail has not landed; conflating them would grant an owner the catalog's
 * authority over a package whose home is a space they cannot even see.
 *
 * Returns `false` while the detail or the space list is still loading, like `can`.
 */
export function useHomeSpacePermission(homeSpaceId: string | null | undefined) {
  const { orgRole } = usePermissions();
  const { data: spaces } = useSpaces();

  const homePermissions = homeSpaceId
    ? (spaces?.find((s) => s.id === homeSpaceId)?.permissions ?? null)
    : null;
  const granted = useMemo(() => new Set<string>(homePermissions ?? []), [homePermissions]);

  return useCallback(
    (permission: GateablePermission) => {
      if (homeSpaceId === undefined) return false;
      if (homeSpaceId === null) return orgRole === "owner" || orgRole === "admin";
      return granted.has(permission);
    },
    [granted, homeSpaceId, orgRole],
  );
}

/**
 * Display name of a package's home space, or `null` when there is none to show
 * — the organization catalog (`home_space_id: null`), or a space this caller
 * cannot enter, which `GET /api/spaces` does not list for them.
 */
export function useHomeSpaceName(homeSpaceId: string | null | undefined): string | null {
  const { data: spaces } = useSpaces();
  return (homeSpaceId && spaces?.find((s) => s.id === homeSpaceId)?.name) || null;
}

/**
 * Permission gating for the UI.
 *
 * `can` answers over the caller's ORG-level effective set (`GET /api/orgs`)
 * union their SPACE-level set in the current space (`GET /api/spaces`). Both
 * arrays are computed and ceiling-applied server-side, so the SPA never
 * derives a permission from a role name — it asks for the exact string the
 * guard checks. Actual enforcement stays server-side; this only controls what
 * is rendered.
 *
 * `orgRole` is display only (badges, labels); a space role is read off the
 * space itself (`GET /api/spaces` → `role`), where the renderer already is.
 */
export function usePermissions() {
  const { currentOrg } = useOrg();
  const spaceId = useCurrentSpaceId();
  const { data: spaces, isLoading: spacesLoading } = useSpaces();

  const space = spaces?.find((s) => s.id === spaceId) ?? null;
  const orgPermissions = currentOrg?.permissions;
  const spacePermissions = space?.permissions;

  const granted = useMemo(
    () => new Set<string>([...(orgPermissions ?? []), ...(spacePermissions ?? [])]),
    [orgPermissions, spacePermissions],
  );

  const can = useCallback((permission: GateablePermission) => granted.has(permission), [granted]);

  // `can` answers `false` for a set that has not loaded yet, which reads the
  // same as a denial. A gate that REFUSES on that answer (rather than merely
  // hiding a button) has to wait, or a hard reload flashes "no access" before
  // the two lists land. Ready = the org is known AND either a space is resolved
  // or there is none this caller can enter.
  const enterableSpaceExists = spaces?.some((s) => s.access === "member") ?? false;
  const ready = !!currentOrg && !spacesLoading && (!!space || !enterableSpaceExists);

  return { can, ready, orgRole: currentOrg?.role ?? null };
}
