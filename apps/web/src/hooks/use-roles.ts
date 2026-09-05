// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

export type RoleObject = components["schemas"]["RoleObject"];
/** Preset key a space membership may carry (`SpaceAssignment.preset_role`). */
export type SpaceRolePreset = NonNullable<components["schemas"]["SpaceAssignment"]["preset_role"]>;

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

/**
 * Role and space-membership writes refresh the catalogs, the
 * spaces' `permissions` (which also carry the caller's own effective set, so a
 * member editing their own row sees it change), and the member lists' role
 * names.
 */
export function useInvalidateRoles() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/roles"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/roles"] });
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

/** Fold the wire's `preset_role` / `custom_role_id` pair into that one string. */
export function spaceRoleValue(role: {
  preset_role?: string | null;
  custom_role_id?: string | null;
}): string {
  return role.preset_role ? `preset:${role.preset_role}` : `custom:${role.custom_role_id}`;
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
export const DEFAULT_SPACE_ROLE_VALUE = spaceRoleValue({ preset_role: "operator" });

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
  if (role.kind === "preset") return spaceRoleValue({ preset_role: role.key });
  const match = roles?.find((r) => r.kind === "custom" && r.key === role.key);
  return match?.id ? spaceRoleValue({ custom_role_id: match.id }) : undefined;
}

/** Space pickers use the caller's grantable catalog; org invitations use the org catalog. */
export function useSpaceRoleOptions(spaceId?: string): {
  options: SpaceRoleOption[];
  roles?: RoleObject[];
  rolesKnown: boolean;
} {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const scope = useOrgOnlyScope();
  const { data: orgRoles } = useRoles(!spaceId && can("roles:read"));
  const { data: assignableRoles } = $api.useQuery(
    "get",
    "/api/spaces/{id}/roles",
    { params: { path: { id: spaceId ?? "" }, header: scope.header } },
    {
      enabled:
        scope.enabled &&
        !!spaceId &&
        (can("space-members:invite") ||
          can("space-members:change-role") ||
          can("space-settings:write")),
      select: (e) => e.data,
    },
  );
  const roles = spaceId ? assignableRoles : orgRoles;

  const options = useMemo<SpaceRoleOption[]>(() => {
    if (roles) {
      return roles.map((r) => ({
        value: spaceRoleValue({
          preset_role: r.kind === "preset" ? r.key : null,
          custom_role_id: r.id,
        }),
        label: spaceRoleLabel(r, t) ?? r.key,
      }));
    }
    if (spaceId) return [];
    return SPACE_ROLE_PRESETS.map((preset) => ({
      value: spaceRoleValue({ preset_role: preset }),
      label: t(`settings:roles.preset.${preset}`),
    }));
  }, [roles, spaceId, t]);

  return { options, roles, rolesKnown: !!roles };
}
