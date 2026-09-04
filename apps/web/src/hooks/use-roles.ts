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

export function useRoleVocabulary(enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/roles/vocabulary",
    { params: { header: scope.header } },
    { enabled: scope.enabled && enabled, select: (e) => e.data },
  );
}

/** Three caches move with a role edit: the roles, the spaces' `permissions`, and the member lists' role names. */
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

/** `value` folds the wire's `preset_role` / `custom_role_id` into the one string a `<Select>` carries. */
export interface SpaceRoleOption {
  value: string;
  label: string;
}

function spaceRoleValue(role: RoleObject): string {
  return role.kind === "preset" ? `preset:${role.key}` : `custom:${role.id}`;
}

/**
 * A preset is a platform constant with no org-authored name, so its slug is
 * translated; a custom bundle renders the name its author typed.
 *
 * `t` is a parameter, not a hook call, so render paths that already hold a `t`
 * on another namespace reuse this — hence the namespace-qualified key.
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

/** Never the head of the list — that is `admin`. */
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

/** A custom role is reported by `key` but addressed by `id` in a write, hence the lookup. */
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
 * Without `roles:read` the org's bundles are unreachable and the picker falls
 * back to the four presets, which are constants rather than rows. That fallback
 * can ADD a role but never rename one, so a member currently holding a custom
 * bundle must not be edited through it — `rolesKnown` says whether the list is
 * authoritative.
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
