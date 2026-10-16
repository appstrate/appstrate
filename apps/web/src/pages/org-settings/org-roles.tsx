// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { DataTable } from "../../components/data-table";
import { Modal } from "../../components/modal";
import { ErrorState } from "../../components/page-states";
import { TextSkeleton } from "../../components/loading-skeletons";
import { roleI18nKey } from "../../hooks/use-permissions";
import { useOrgRoleGrants } from "../../hooks/use-roles";
import { useUrlModalTarget } from "../../hooks/use-url-modal";
import { permissionLabel } from "../../lib/permission-labels";
import { ORG_ROLE_SPACE_ACCESS, useOrgRoleColumns } from "./org-role-columns";

/** Read the server's grants for one role; preview remains its own action. */
export function OrgRolesList({ onPreview }: { onPreview?: (role: ViewAsOrgRole) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const columns = useOrgRoleColumns({ onPreview });
  const detail = useUrlModalTarget("orgRole", ORG_ROLES, (role) => role);
  const grants = useOrgRoleGrants();
  return (
    <>
      <DataTable
        label={t("roles.tabOrg")}
        columns={columns}
        rows={[...ORG_ROLES]}
        rowKey={(role) => role}
        rowLabel={(role) => t(roleI18nKey(role))}
        rowAction={detail.open}
      />
      {detail.target && (
        <Modal
          onClose={detail.close}
          title={t(roleI18nKey(detail.target))}
          description={`${t(`orgSettings.roleHint.${detail.target}`)} ${t(`orgRolesGuide.access.${ORG_ROLE_SPACE_ACCESS[detail.target]}`)}`}
        >
          {grants.isError ? (
            <ErrorState error={grants.error} />
          ) : !grants.data ? (
            <TextSkeleton lines={6} />
          ) : (
            <ul className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto text-sm">
              {[...(grants.data.get(detail.target) ?? [])].sort().map((permission) => (
                <li key={permission} title={permission}>
                  {permissionLabel(permission, t)}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}
