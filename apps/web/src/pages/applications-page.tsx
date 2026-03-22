import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { AppWindow, Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "../hooks/use-org";
import { useApplications } from "../hooks/use-applications";
import { setCurrentApplicationId } from "../hooks/use-current-application";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ApplicationCreateModal } from "../components/application-create-modal";

export function ApplicationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: applications, isLoading, error } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  const handleAppClick = (appId: string) => {
    setCurrentApplicationId(appId);
    navigate("/app-settings");
  };

  if (!isOrgAdmin) {
    return (
      <EmptyState message={t("applications.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <Button variant="outline">{t("btn.back")}</Button>
        </Link>
      </EmptyState>
    );
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h2>{t("applications.pageTitle")}</h2>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} className="mr-1.5" />
          {t("applications.create")}
        </Button>
      </div>

      {!applications || applications.length === 0 ? (
        <EmptyState
          message={t("applications.empty")}
          hint={t("applications.emptyHint")}
          icon={AppWindow}
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} className="mr-1.5" />
            {t("applications.create")}
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {applications.map((app) => (
            <button
              key={app.id}
              type="button"
              onClick={() => handleAppClick(app.id)}
              className="rounded-lg border border-border bg-card p-5 hover:border-primary/30 transition-colors text-left w-full"
            >
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
              </div>
            </button>
          ))}
        </div>
      )}

      <ApplicationCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
