// SPDX-License-Identifier: Apache-2.0

/**
 * The organisation roles, in the roles page's first tab.
 *
 * Four fixed roles, the same in every organisation: code, not rows, so there
 * is nothing to edit and the rows open nothing. The list says what each one is
 * and how far it reaches into spaces; the matrix crosses them with the
 * capabilities they hold.
 *
 * The facts behind both views live in `org-role-columns.tsx`, which mirrors the
 * server's matrix.
 */
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { DataTable } from "../../components/data-table";
import { PermissionMark } from "../../components/permission-mark";
import { roleI18nKey } from "../../hooks/use-permissions";
import { MATRIX_HEAD } from "../../lib/matrix-head";
import {
  ORG_ROLES_ORDER,
  ORG_ROLE_CAPABILITIES,
  ORG_ROLE_SPACE_ACCESS,
  useOrgRoleColumns,
} from "./org-role-columns";

export function OrgRolesList() {
  const { t } = useTranslation(["settings", "common"]);
  const columns = useOrgRoleColumns();
  return (
    <DataTable
      label={t("roles.tabOrg")}
      columns={columns}
      rows={[...ORG_ROLES_ORDER]}
      rowKey={(role) => role}
      isLoading={false}
    />
  );
}

export function OrgRolesMatrix() {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="bg-card overflow-hidden rounded-lg border shadow-sm">
      <Table className="w-full" style={{ minWidth: 224 + ORG_ROLES_ORDER.length * 96 }}>
        <TableHeader>
          <TableRow>
            <TableHead className={MATRIX_HEAD}>{t("orgRolesGuide.capability")}</TableHead>
            {ORG_ROLES_ORDER.map((role) => (
              <TableHead
                key={role}
                className={`${MATRIX_HEAD} w-24 text-center leading-tight whitespace-normal`}
              >
                {t(roleI18nKey(role))}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ORG_ROLE_CAPABILITIES.map((capability) => (
            <TableRow key={capability.key}>
              <TableCell className="text-sm whitespace-normal">
                {t(`orgRolesGuide.can.${capability.key}`)}
              </TableCell>
              {ORG_ROLES_ORDER.map((role) => (
                <TableCell key={role} className="text-center">
                  <PermissionMark granted={capability.roles.includes(role)} />
                </TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="text-sm font-medium">{t("orgRolesGuide.spaceAccess")}</TableCell>
            {ORG_ROLES_ORDER.map((role) => (
              <TableCell
                key={role}
                className="text-muted-foreground text-center text-xs whitespace-normal"
              >
                {t(`orgRolesGuide.access.${ORG_ROLE_SPACE_ACCESS[role]}`)}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
