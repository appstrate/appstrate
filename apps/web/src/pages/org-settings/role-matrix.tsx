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
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { PermissionMark } from "../../components/permission-mark";
import { spaceRoleLabel, useRoleVocabulary, type RoleObject } from "../../hooks/use-roles";
import { MATRIX_HEAD } from "../../lib/matrix-head";
import {
  groupPermissionsByResource,
  permissionLabel,
  permissionResourceLabel,
} from "../../lib/permission-labels";

/**
 * The table takes the dialog's width and the permission column what is left,
 * wrapping its labels; role columns are fixed. It only scrolls once the roles
 * outgrow the dialog. Sized to its content instead (`w-max`), the longest label
 * refused to wrap and pushed a role that would have fitted out of view.
 */
const PERMISSION_COLUMN = 224;
const ROLE_COLUMN = 96;

export function RoleMatrix({ roles }: { roles: RoleObject[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: vocabulary } = useRoleVocabulary();

  // The rows are the catalog once it answered; before that, every permission
  // some role holds — the admin preset holds the lot, so nothing is missing.
  const permissions = vocabulary
    ? vocabulary.flatMap((group) => group.permissions.map((entry) => entry.permission))
    : [...new Set(roles.flatMap((role) => role.permissions))].sort();
  const held = roles.map((role) => new Set(role.permissions));
  const firstCustom = roles.findIndex((role) => role.kind === "custom");

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
        {t("roles.matrixOrgNote")}
      </p>
      <div className="bg-card overflow-hidden rounded-lg border shadow-sm">
        <Table
          aria-label={t("roles.matrixLabel")}
          className="w-full"
          style={{ minWidth: PERMISSION_COLUMN + roles.length * ROLE_COLUMN }}
        >
          <TableHeader>
            <TableRow>
              <TableHead className={cn(MATRIX_HEAD, "bg-card sticky left-0 z-10")}>
                {t("roles.matrixPermission")}
              </TableHead>
              {roles.map((role, index) => (
                <TableHead
                  key={role.id ?? role.key}
                  className={cn(
                    MATRIX_HEAD,
                    "w-24 text-center leading-tight whitespace-normal",
                    index === firstCustom && "border-l",
                  )}
                >
                  {spaceRoleLabel(role, t) ?? role.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupPermissionsByResource(permissions).map(([resource, group]) => (
              <Fragment key={resource}>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={roles.length + 1}
                    className="bg-muted/50 sticky left-0 py-1.5 text-xs font-semibold"
                  >
                    {permissionResourceLabel(resource, t)}
                  </TableCell>
                </TableRow>
                {group.map((permission) => (
                  <TableRow key={permission}>
                    <TableCell
                      className="bg-card sticky left-0 z-10 text-sm whitespace-normal"
                      title={permission}
                    >
                      {permissionLabel(permission, t)}
                    </TableCell>
                    {roles.map((role, index) => (
                      <TableCell
                        key={role.id ?? role.key}
                        className={cn("text-center", index === firstCustom && "border-l")}
                      >
                        <PermissionMark granted={held[index]!.has(permission)} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
