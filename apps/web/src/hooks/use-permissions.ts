// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo } from "react";
import { useOrg } from "./use-org.ts";
import { useSpaceLabelOf, useSpaces } from "./use-spaces.ts";
import type { SpaceGrant } from "../lib/package-permissions.ts";
import { isSpaceEnterable, useCurrentSpaceId } from "./use-current-space.ts";
import type { OrgRole } from "@appstrate/shared-types";
import type { CorePermission } from "@appstrate/core/permissions";
import { hasFullOrgAccess } from "../lib/org-role.ts";

/** A permission string `can()` accepts. The open `string` arm keeps module-contributed strings callable (the SPA does not import module packages). */
export type GateablePermission = CorePermission | (string & {});

const ROLE_I18N_KEY: Record<OrgRole, string> = {
  owner: "orgSettings.roleOwner",
  admin: "orgSettings.roleAdmin",
  member: "orgSettings.roleMember",
  guest: "orgSettings.roleGuest",
};

export function roleI18nKey(role: OrgRole): string {
  return ROLE_I18N_KEY[role];
}

/**
 * Who may preview a role — the server's eligibility rule (`validateViewAs`). A role, not a
 * permission: "a preview only removes" holds only while the previewer outranks every persona.
 */
export function useCanPreviewRole(): boolean {
  return hasFullOrgAccess(usePermissions().orgRole);
}

/**
 * Display name of a package's home space, or `null`. `home_space_id` is already `null` when the
 * caller does not reach the home (RBAC spec §6.9); write access is `home_writable` on the package read.
 */
export function useHomeSpaceName(homeSpaceId: string | null | undefined): string | null {
  return useSpaceLabelOf()(homeSpaceId) ?? null;
}

/**
 * Permission gating for the UI (enforcement stays server-side). `can` answers over the org-level
 * effective set (`GET /api/orgs`) union the current space's (`GET /api/spaces`), both computed
 * server-side: never derive a permission from a role name. `orgRole` serves labels and the few
 * rules the server keys on the role ({@link hasFullOrgAccess}).
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

  // `can` is `false` before the sets load, same as a denial: a gate that REFUSES on it must wait
  // for `ready` (org known AND a space resolved or none enterable), or a reload flashes "no
  // access". Only `useSpaceResolver` resolves a space, so `ready` never settles outside MainLayout.
  const enterableSpaceExists = spaces?.some(isSpaceEnterable) ?? false;
  const ready = !!currentOrg && !spacesLoading && (!!space || !enterableSpaceExists);

  return {
    can,
    ready,
    orgRole: currentOrg?.role ?? null,
    /** The current space is the caller's personal one (`teamSpaceOnly` routes are absent there). */
    inPersonalSpace: space?.personal ?? false,
  };
}

/**
 * The caller's standing in ONE named space (`maySetPackageActive`). Activation is judged in the
 * TARGET space and owning it is its own authorization — neither survives the org∪space union
 * `can` computes. Works for a space the caller is not standing in; the server already unions the
 * org half into every row (`effectiveInSpace`). `undefined` (loading, no space, unreached) reads
 * as "not yet", never as a refusal.
 */
export function useSpaceGrant(spaceId: string | null | undefined): SpaceGrant | undefined {
  const { data: spaces } = useSpaces();
  const space = spaceId ? spaces?.find((s) => s.id === spaceId) : undefined;
  if (!space) return undefined;
  return {
    permissions: space.permissions,
    personal: space.personal,
    access: space.access,
  };
}

export function useCurrentSpaceGrant(): SpaceGrant | undefined {
  return useSpaceGrant(useCurrentSpaceId());
}
