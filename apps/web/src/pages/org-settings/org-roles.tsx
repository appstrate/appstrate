// SPDX-License-Identifier: Apache-2.0

/**
 * The four fixed organization roles (code, not rows: nothing to edit). Which
 * role holds which capability is the server's matrix (`GET /api/org-roles`);
 * the rows only group its permissions (`lib/org-role-capabilities.ts`).
 */
import { useTranslation } from "react-i18next";
import { ORG_ROLES, type OrgRole, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { DataTable } from "../../components/data-table";
import { PermissionMark } from "../../components/permission-mark";
import { PermissionMatrix } from "../../components/permission-matrix";
import { roleI18nKey } from "../../hooks/use-permissions";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useOrgRoleGrants } from "../../hooks/use-roles";
import { holdsCapability, ORG_ROLE_CAPABILITIES } from "../../lib/org-role-capabilities";
import { ORG_ROLE_SPACE_ACCESS, useOrgRoleColumns } from "./org-role-columns";

export function OrgRolesList({ onPreview }: { onPreview?: (role: ViewAsOrgRole) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const columns = useOrgRoleColumns({ onPreview });
  return (
    <DataTable
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
  const grants = useOrgRoleGrants();
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
            cell: (role) => {
              const granted = grants?.get(role);
              return granted ? (
                <PermissionMark granted={holdsCapability(capability, granted)} />
              ) : (
                <Skeleton className="mx-auto size-4" />
              );
            },
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
