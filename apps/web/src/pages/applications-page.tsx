import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { AppWindow, Settings } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApplications } from "../hooks/use-applications";
import { setCurrentApplicationId } from "../hooks/use-current-application";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ApplicationCreateModal } from "../components/application-create-modal";

export function ApplicationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: applications, isLoading, error } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  if (!isAdmin) return null;

  const handleAppClick = (appId: string) => {
    setCurrentApplicationId(appId);
    navigate("/app-settings");
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <PageHeader
        title={t("applications.pageTitle")}
        emoji="♻️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("applications.pageTitle") },
        ]}
        actions={<Button onClick={() => setCreateOpen(true)}>{t("applications.create")}</Button>}
      />

      {!applications || applications.length === 0 ? (
        <EmptyState
          message={t("applications.empty")}
          hint={t("applications.emptyHint")}
          icon={AppWindow}
        >
          <Button onClick={() => setCreateOpen(true)}>{t("applications.create")}</Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {applications.map((app) => (
            <div key={app.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <h3 className="text-[0.95rem] font-semibold">{app.name}</h3>
                  <span className="text-sm text-muted-foreground">
                    {t("applications.createdAt", {
                      date: new Date(app.createdAt).toLocaleDateString(i18n.language, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      }),
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
          ))}
        </div>
      )}

      <ApplicationCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
