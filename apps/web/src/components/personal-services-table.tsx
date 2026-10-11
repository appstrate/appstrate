// SPDX-License-Identifier: Apache-2.0

/**
 * The personal keys table (Settings › Models › Clés perso): the services the organization
 * opened to personal keys. The page owns what its deeds do.
 */

import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { DataTable } from "./data-table";
import { EmptyState, ErrorState } from "./page-states";
import { usePersonalServiceColumns } from "../pages/org-settings/personal-service-columns";
import type { PersonalServiceRow } from "../lib/model-providers";

export function PersonalServicesTable({
  rows,
  isLoading,
  error,
  canWriteModels,
  onChooseModels,
}: {
  rows: PersonalServiceRow[];
  isLoading: boolean;
  error: unknown;
  canWriteModels: boolean;
  onChooseModels: (row: PersonalServiceRow) => void;
}) {
  const { t } = useTranslation("settings");
  const columns = usePersonalServiceColumns({ canWriteModels, onChooseModels });
  return (
    <DataTable
      label={t("providers.personalTableLabel")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      // A click on a service's row chooses the models its personal keys serve.
      rowAction={onChooseModels}
      rowActionable={() => canWriteModels}
      rowLabel={(row) => row.service.displayName}
      isLoading={isLoading}
      isError={Boolean(error)}
      error={<ErrorState error={error} compact />}
      empty={<EmptyState message={t("providers.personalEmpty")} icon={KeyRound} compact />}
    />
  );
}
