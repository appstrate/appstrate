// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { useApplications } from "../../hooks/use-applications";
import { useAppSwitcher } from "../../hooks/use-current-application";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { useApplicationColumns } from "./application-columns";
import { ApplicationCreateModal } from "../../components/application-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsApplicationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: applications, isLoading, error } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { switchApp } = useAppSwitcher();

  const handleAppClick = (applicationId: string) => {
    switchApp(applicationId);
    navigate("/org-settings/app/general");
  };

  // Above the admin gate: a hook called after an early return is a hook called
  // conditionally, which the Rules-of-React lint refuses and React punishes.
  const columns = useApplicationColumns({
    defaultLabel: t("applications.default"),
    onOpen: handleAppClick,
  });

  if (!isAdmin) return null;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button data-testid="create-application-button" onClick={() => setCreateOpen(true)}>
          {t("applications.create")}
        </Button>
      </div>

      <DataTable
        label={t("applications.pageTitle")}
        columns={columns}
        rows={applications ?? []}
        rowKey={(app) => app.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          <EmptyState
            message={t("applications.empty")}
            hint={t("applications.emptyHint")}
            icon={AppWindow}
          >
            <Button onClick={() => setCreateOpen(true)}>{t("applications.create")}</Button>
          </EmptyState>
        }
      />

      <ApplicationCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
