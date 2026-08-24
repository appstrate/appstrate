// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { useApplications } from "../../hooks/use-applications";
import { useAppSwitcher } from "../../hooks/use-current-application";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { useApplicationColumns } from "./application-columns";
import { TOOLBAR_ACTION } from "../../lib/toolbar-button";
import { ApplicationCreateModal } from "../../components/application-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsApplicationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: applications, isLoading, error } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { switchApp } = useAppSwitcher();

  const handleAppClick = (applicationId: string) => {
    switchApp(applicationId);
    navigate("/workspace-settings/general", { state: location.state });
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
      <SettingsPageActions>
        <Button
          variant="outline"
          className={TOOLBAR_ACTION}
          data-testid="create-application-button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus />
          {t("applications.create")}
        </Button>
      </SettingsPageActions>

      <DataTable
        label={t("applications.pageTitle")}
        columns={columns}
        rows={applications ?? []}
        rowKey={(app) => app.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          // No action of its own: the button above is the same one, and it
          // stays now that the early return is gone.
          <EmptyState
            message={t("applications.empty")}
            hint={t("applications.emptyHint")}
            icon={AppWindow}
          />
        }
      />

      <ApplicationCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
