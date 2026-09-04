// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

export type RoleObject = components["schemas"]["RoleObject"];
/** Preset key a space membership may carry (`SpaceAssignment.preset_role`). */
export type SpaceRolePreset = NonNullable<components["schemas"]["SpaceAssignment"]["preset_role"]>;

export const SPACE_ROLE_PRESETS = ["admin", "builder", "operator", "viewer"] as const;

/** Presets + the org's own bundles, in the order the API returns them. */
export function useRoles(enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/roles",
    { params: { header: scope.header } },
    { enabled: scope.enabled && enabled, select: (e) => e.data },
  );
}

/** The space-level permission strings a custom role may hold, by resource. */
export function useRoleVocabulary(enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/roles/vocabulary",
    { params: { header: scope.header } },
    { enabled: scope.enabled && enabled, select: (e) => e.data },
  );
}

/**
 * A role edit changes what its holders can do, so three caches move with it:
 * the role list, the space list (which carries each caller's effective
 * `permissions`) and every space's member list (which renders the role name).
 */
function useInvalidateRoles() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/roles"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/members"] });
  };
}

export function useCreateRole() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("post", "/api/roles", { onSuccess: invalidate });
}

export function useUpdateRole() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("patch", "/api/roles/{id}", { onSuccess: invalidate });
}

export function useDeleteRole() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("delete", "/api/roles/{id}", { onSuccess: invalidate });
}

/**
 * One entry of a "which role in this space" picker.
 *
 * `value` encodes the two shapes the API accepts (`preset_role` vs
 * `custom_role_id`) into a single select value, because a `<Select>` carries
 * one string and the two are mutually exclusive on the wire.
 */
export interface SpaceRoleOption {
  value: string;
  label: string;
}

/** The select value for a role row. */
function spaceRoleValue(role: RoleObject): string {
  return role.kind === "preset" ? `preset:${role.key}` : `custom:${role.id}`;
}

/**
 * The role's display name.
 *
 * A preset arrives from the API as its raw slug (`operator`) — it is a platform
 * constant with no org-authored name, so it is translated here. A custom bundle
 * carries the name its author typed and is rendered verbatim.
 *
 * `t` is passed in rather than pulled from a hook so the same rule applies in
 * render paths that already own a `t` on another namespace (the org switcher);
 * the key is namespace-qualified for exactly that reason.
 */
export function spaceRoleLabel(
  role: { kind: "preset" | "custom"; key: string; name: string } | null | undefined,
  t: (key: string) => string,
): string | null {
  if (!role) return null;
  return role.kind === "preset" ? t(`settings:roles.preset.${role.key}`) : role.name;
}

/** Same rule for the one-line description shown on the roles page. */
export function spaceRoleDescription(role: RoleObject, t: (key: string) => string): string | null {
  return role.kind === "preset" ? t(`settings:roles.presetDesc.${role.key}`) : role.description;
}

/** The preset every "pick a role" control starts on. Never the head of the list — that is `admin`. */
export const DEFAULT_SPACE_ROLE_VALUE = "preset:operator";

/** Turn a select value back into the request body's role half. */
export function spaceRoleAssignment(value: string): {
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
} {
  const [kind, ...rest] = value.split(":");
  const key = rest.join(":");
  return kind === "preset" ? { preset_role: key as SpaceRolePreset } : { custom_role_id: key };
}

/**
 * The select value matching a membership's current role. A custom role is
 * reported by `key` on a membership but addressed by `id` in a write, so it is
 * resolved through the role list.
 */
export function memberRoleValue(
  role: { kind: "preset" | "custom"; key: string } | null,
  roles: RoleObject[] | undefined,
): string | undefined {
  if (!role) return undefined;
  if (role.kind === "preset") return `preset:${role.key}`;
  const match = roles?.find((r) => r.kind === "custom" && r.key === role.key);
  return match?.id ? `custom:${match.id}` : undefined;
}

/**
 * Assignable space roles for a picker.
 *
 * Without `roles:read` the org's own bundles are unreachable, so the picker
 * falls back to the four platform presets — they are constants, not rows. That
 * fallback can only ADD a role, never rename one, which is why a member whose
 * current role is a custom bundle must not be edited through it (`rolesKnown`
 * says whether the list is authoritative; see `space/members.tsx`).
 */
export function useSpaceRoleOptions(): {
  options: SpaceRoleOption[];
  roles?: RoleObject[];
  rolesKnown: boolean;
} {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const { data: roles } = useRoles(can("roles:read"));

  const options = useMemo<SpaceRoleOption[]>(() => {
    if (roles) {
      return roles.map((r) => ({
        value: spaceRoleValue(r),
        label: spaceRoleLabel(r, t) ?? r.key,
      }));
    }
    return SPACE_ROLE_PRESETS.map((preset) => ({
      value: `preset:${preset}`,
      label: t(`settings:roles.preset.${preset}`),
    }));
  }, [roles, t]);

  return { options, roles, rolesKnown: !!roles };
}
