// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Settings } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { useApplications } from "../../hooks/use-applications";
import { useAppSwitcher } from "../../hooks/use-current-application";
import { ErrorState, EmptyState } from "../../components/page-states";
import { ItemList } from "../../components/item-list";
import { ApplicationCreateModal } from "../../components/application-create-modal";
import { formatDateField } from "../../lib/markdown";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsApplicationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: applications, isLoading, error } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { switchApp } = useAppSwitcher();

  if (!isAdmin) return null;

  const handleAppClick = (applicationId: string) => {
    switchApp(applicationId);
    navigate("/org-settings/app/general");
  };

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button data-testid="create-application-button" onClick={() => setCreateOpen(true)}>
          {t("applications.create")}
        </Button>
      </div>

      <ItemList
        items={applications ?? []}
        itemKey={(app) => app.id}
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
        renderItem={(app) => (
          <div
            data-testid={`application-card-${app.id}`}
            className="border-border bg-card rounded-lg border p-5"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-[0.95rem] font-semibold">{app.name}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("applications.createdAt", {
                    date: formatDateField(app.createdAt, "date"),
                  })}
                </span>
              </div>
              {app.isDefault && <Badge variant="running">{t("applications.default")}</Badge>}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleAppClick(app.id)}
                title={t("nav.appSettings", { ns: "common" })}
              >
                <Settings size={16} />
              </Button>
            </div>
          </div>
        )}
      />

      <ApplicationCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
