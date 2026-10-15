// SPDX-License-Identifier: Apache-2.0

/**
 * The organization roles, in the roles page's first tab.
 *
 * Four fixed roles, the same in every organization: code, not rows, so there
 * is nothing to edit and the rows open nothing. The list says what each one is
 * and how far it reaches into spaces; the matrix crosses them with the
 * capabilities they hold.
 *
 * The facts behind both views live in `org-role-columns.tsx`, which mirrors the
 * server's matrix.
 */
import { useTranslation } from "react-i18next";
import { ORG_ROLES, type OrgRole, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { DataTable } from "../../components/data-table";
import { PermissionMark } from "../../components/permission-mark";
import { PermissionMatrix } from "../../components/permission-matrix";
import { roleI18nKey } from "../../hooks/use-permissions";
import { ORG_ROLE_CAPABILITIES } from "../../lib/org-role-capabilities";
import { ORG_ROLE_SPACE_ACCESS, useOrgRoleColumns } from "./org-role-columns";

export function OrgRolesList({ onPreview }: { onPreview?: (role: ViewAsOrgRole) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const columns = useOrgRoleColumns({ onPreview });
  return (
    <DataTable
      tableId="org-roles"
      label={t("roles.tabOrg")}
      columns={columns}
      rows={[...ORG_ROLES]}
      rowKey={(role) => role}
      isLoading={false}
    />
  );
}

export function OrgRolesMatrix() {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <PermissionMatrix<OrgRole>
      ariaLabel={t("orgRolesGuide.matrixLabel")}
      firstHeader={t("orgRolesGuide.capability")}
      columns={ORG_ROLES.map((role) => ({ key: role, label: t(roleI18nKey(role)) }))}
      groups={[
        {
          rows: ORG_ROLE_CAPABILITIES.map((capability) => ({
            key: capability.key,
            label: t(`orgRolesGuide.can.${capability.key}`),
            cell: (role) => <PermissionMark granted={capability.roles.includes(role)} />,
          })),
        },
        {
          rows: [
            {
              key: "spaceAccess",
              label: <span className="font-medium">{t("orgRolesGuide.spaceAccess")}</span>,
              cell: (role) => (
                <span className="text-muted-foreground text-xs whitespace-normal">
                  {t(`orgRolesGuide.access.${ORG_ROLE_SPACE_ACCESS[role]}`)}
                </span>
              ),
            },
          ],
        },
      ]}
    />
  );
}
