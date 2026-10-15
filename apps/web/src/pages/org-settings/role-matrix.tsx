// SPDX-License-Identifier: Apache-2.0

/**
 * Every space role against every permission.
 *
 * The role modal answers "what can this role do". Choosing a role to hand out
 * asks the other question — who can launch an agent, what separates an
 * operator from a runner — and only a crossed view answers it.
 *
 * It is a MATRIX, not a list: a column is another role, not an attribute of
 * the row, so dropping one for width would hide an answer. It keeps the raw
 * table and scrolls, like the library's packages × spaces, with the permission
 * column pinned so a row stays readable wherever it scrolled to.
 */
import { useTranslation } from "react-i18next";
import { PermissionMark } from "../../components/permission-mark";
import { PermissionMatrix } from "../../components/permission-matrix";
import { spaceRoleLabel, useRoleVocabulary, type RoleObject } from "../../hooks/use-roles";
import {
  groupPermissionsByResource,
  permissionLabel,
  permissionResourceLabel,
} from "../../lib/permission-labels";

export function RoleMatrix({ roles }: { roles: RoleObject[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: vocabulary } = useRoleVocabulary();

  // The rows are the catalog once it answered; before that, every permission
  // some role holds — the admin preset holds the lot, so nothing is missing.
  const permissions = vocabulary
    ? vocabulary.flatMap((group) => group.permissions.map((entry) => entry.permission))
    : [...new Set(roles.flatMap((role) => role.permissions))].sort();
  const columnKey = (role: RoleObject) => role.id ?? role.key;
  const held = new Map(roles.map((role) => [columnKey(role), new Set(role.permissions)]));
  const firstCustom = roles.find((role) => role.kind === "custom");

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
        {t("roles.matrixOrgNote")}
      </p>
      <PermissionMatrix
        ariaLabel={t("roles.matrixLabel")}
        firstHeader={t("roles.matrixPermission")}
        columns={roles.map((role) => ({
          key: columnKey(role),
          label: spaceRoleLabel(role, t) ?? role.name,
          dividerBefore: role === firstCustom,
        }))}
        groups={groupPermissionsByResource(permissions).map(([resource, group]) => ({
          label: permissionResourceLabel(resource, t),
          rows: group.map((permission) => ({
            key: permission,
            label: permissionLabel(permission, t),
            title: permission,
            cell: (column) => <PermissionMark granted={held.get(column)!.has(permission)} />,
          })),
        }))}
      />
    </div>
  );
}
