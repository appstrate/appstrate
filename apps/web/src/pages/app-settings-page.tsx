// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { AppWindow, Plus, X } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useApplication,
  useUpdateApplication,
  useDeleteApplication,
} from "../hooks/use-applications";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";

interface SettingsFormData {
  name: string;
}

export function AppSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const appId = useCurrentApplicationId();

  const { data: application, isLoading, error } = useApplication(appId ?? "");
  const updateMutation = useUpdateApplication();
  const deleteMutation = useDeleteApplication();

  const domains = application?.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const activeDomains = editedDomains ?? domains;

  const { register, handleSubmit, showError } = useAppForm<SettingsFormData>({
    values: { name: application?.name ?? "" },
  });

  if (!isAdmin) return null;
  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!application) return <ErrorState />;

  const onSubmit = (data: SettingsFormData) => {
    updateMutation.mutate({
      id: appId,
      data: { name: data.name.trim(), settings: { allowedRedirectDomains: activeDomains } },
    });
  };

  return (
    <>
      <PageHeader
        title={application.name}
        emoji="⚙️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("applications.pageTitle", { ns: "settings" }), href: "/applications" },
          { label: application.name },
        ]}
        actions={
          application.isDefault ? (
            <Badge variant="running">{t("applications.default")}</Badge>
          ) : undefined
        }
      />

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-6">
        <div className="space-y-2">
          <Label htmlFor="app-name">{t("applications.nameLabel")}</Label>
          <Input
            id="app-name"
            type="text"
            {...register("name", { required: true })}
            placeholder={t("applications.namePlaceholder")}
          />
          {showError("name") && (
            <p className="text-destructive text-sm">{t("validation.required", { ns: "common" })}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("applications.redirectDomains")}</Label>
          <p className="text-muted-foreground text-sm">{t("applications.redirectDomainsHint")}</p>
          <div className="flex flex-col gap-2">
            {activeDomains.map((domain, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={domain}
                  onChange={(e) =>
                    setEditedDomains((prev) =>
                      (prev ?? domains).map((d, i) => (i === index ? e.target.value : d)),
                    )
                  }
                  placeholder="example.com"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setEditedDomains((prev) => (prev ?? domains).filter((_, i) => i !== index))
                  }
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditedDomains((prev) => [...(prev ?? domains), ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("applications.addDomain")}
            </Button>
          </div>
        </div>

        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? <Spinner /> : t("btn.save")}
        </Button>
      </form>

      {!application.isDefault && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("applications.dangerZone")}
          </div>
          <div className="border-destructive bg-card max-w-xl rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("applications.deleteTitle")}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("applications.deleteDesc")}
                </span>
              </div>
              <Button
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                {deleteMutation.isPending ? t("applications.deleting") : t("btn.delete")}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("applications.deleteConfirm", { name: application.name })}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(appId, {
            onSuccess: () => {
              setConfirmOpen(false);
              navigate("/applications");
            },
          });
        }}
      />
    </>
  );
}
