// SPDX-License-Identifier: Apache-2.0

/**
 * Every space role against every permission. A MATRIX, not a list: a column is
 * another role, so dropping one for width would hide an answer; it scrolls with
 * the permission column pinned.
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
import { STUDIO_PERMISSION } from "../../lib/route-access";

export function RoleMatrix({ roles }: { roles: RoleObject[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: vocabulary } = useRoleVocabulary();

  // Rows: the catalog once loaded; before that every permission some role holds (admin holds the
  // lot). The Studio is its own last row, read from `shows_studio` for every role: the catalog
  // does not list it, a custom role never stores it, a preset spells it among its permissions.
  const permissions = vocabulary
    ? vocabulary.flatMap((group) => group.permissions.map((entry) => entry.permission))
    : [...new Set(roles.flatMap((role) => role.permissions))]
        .filter((permission) => permission !== STUDIO_PERMISSION)
        .sort();
  const columnKey = (role: RoleObject) => role.id ?? role.key;
  const held = new Map(roles.map((role) => [columnKey(role), new Set(role.permissions)]));
  const showsStudio = new Map(roles.map((role) => [columnKey(role), role.shows_studio]));
  const firstCustom = roles.find((role) => role.kind === "custom");

  return (
    <div className="flex flex-col gap-3">
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
        groups={[
          ...groupPermissionsByResource(permissions).map(([resource, group]) => ({
            label: permissionResourceLabel(resource, t),
            rows: group.map((permission) => ({
              key: permission,
              label: permissionLabel(permission, t),
              title: permission,
              cell: (column: string) => (
                <PermissionMark granted={held.get(column)!.has(permission)} />
              ),
            })),
          })),
          {
            label: permissionResourceLabel("studio", t),
            rows: [
              {
                key: STUDIO_PERMISSION,
                label: t("roles.showsStudio"),
                title: STUDIO_PERMISSION,
                cell: (column: string) => (
                  <PermissionMark granted={showsStudio.get(column) === true} />
                ),
              },
            ],
          },
        ]}
      />
    </div>
  );
}
