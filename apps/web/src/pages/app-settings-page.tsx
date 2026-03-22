import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { AppWindow, Plus, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrg } from "../hooks/use-org";
import {
  useApplication,
  useUpdateApplication,
  useDeleteApplication,
} from "../hooks/use-applications";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";

interface SettingsFormData {
  name: string;
}

export function AppSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { isOrgAdmin } = useOrg();
  const appId = useCurrentApplicationId();

  const { data: application, isLoading, error } = useApplication(appId ?? "");
  const updateMutation = useUpdateApplication();
  const deleteMutation = useDeleteApplication();

  const domains = application?.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const activeDomains = editedDomains ?? domains;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SettingsFormData>({
    values: { name: application?.name ?? "" },
  });

  if (!isOrgAdmin) {
    return <EmptyState message={t("applications.adminOnly")} icon={ShieldAlert} />;
  }

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

  const handleDelete = () => {
    if (!confirm(t("applications.deleteConfirm", { name: application.name }))) return;
    deleteMutation.mutate(appId, {
      onSuccess: () => navigate("/applications"),
    });
  };

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <h2>{t("applications.tabSettings")}</h2>
        {application.isDefault && <Badge variant="running">{t("applications.default")}</Badge>}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 max-w-xl">
        <div className="space-y-2">
          <Label htmlFor="app-name">{t("applications.nameLabel")}</Label>
          <Input
            id="app-name"
            type="text"
            {...register("name", { required: true })}
            placeholder={t("applications.namePlaceholder")}
          />
          {errors.name && (
            <p className="text-sm text-destructive">{t("validation.required", { ns: "common" })}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("applications.redirectDomains")}</Label>
          <p className="text-sm text-muted-foreground">{t("applications.redirectDomainsHint")}</p>
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
          <div className="text-sm font-medium text-muted-foreground mb-4 mt-8">
            {t("applications.dangerZone")}
          </div>
          <div className="rounded-lg border border-destructive bg-card p-5 max-w-xl">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("applications.deleteTitle")}</h3>
                <span className="text-sm text-muted-foreground">
                  {t("applications.deleteDesc")}
                </span>
              </div>
              <Button
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={handleDelete}
              >
                {deleteMutation.isPending ? t("applications.deleting") : t("btn.delete")}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
