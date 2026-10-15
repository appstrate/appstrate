// SPDX-License-Identifier: Apache-2.0

/** The four fixed organization roles (code, not rows: nothing to edit). */
import { useTranslation } from "react-i18next";
import { ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { DataTable } from "../../components/data-table";
import { useOrgRoleColumns } from "./org-role-columns";

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
