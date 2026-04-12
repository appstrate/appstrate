// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { AppWindow, Plus, X } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useApplication,
  useUpdateApplication,
  useDeleteApplication,
} from "../hooks/use-applications";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import { AppProfilesTab } from "../components/app-profiles-tab";
import { useAppConfig } from "../hooks/use-app-config";
const OAuthClientsTab = lazy(() =>
  import("../modules/oidc/components/oauth-clients-tab").then((m) => ({
    default: m.OAuthClientsTab,
  })),
);

interface SettingsFormData {
  name: string;
}

const BASE_TABS = ["general", "profiles"] as const;
type Tab = "general" | "profiles" | "oauth";

export function AppSettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const appId = useCurrentApplicationId();
  const { data: application, isLoading, error } = useApplication(appId ?? "");
  const { features } = useAppConfig();
  const oidcEnabled = features.oidc === true;
  const tabs: readonly Tab[] = oidcEnabled
    ? [...BASE_TABS, "oauth"]
    : (BASE_TABS as readonly Tab[]);
  const [tab, setTab] = useTabWithHash<Tab>(tabs, "general");

  if (!isAdmin) return null;
  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!application) return <ErrorState />;

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
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-2">
          <TabsList>
            <TabsTrigger value="general">{t("appSettings.tabGeneral")}</TabsTrigger>
            <TabsTrigger value="profiles">{t("appSettings.tabProfiles")}</TabsTrigger>
            {oidcEnabled && <TabsTrigger value="oauth">{t("appSettings.tabOauth")}</TabsTrigger>}
          </TabsList>
        </Tabs>
      </PageHeader>

      {tab === "general" && <GeneralTab appId={appId} application={application} />}
      {tab === "profiles" && <AppProfilesTab />}
      {tab === "oauth" && oidcEnabled && (
        <Suspense fallback={<LoadingState />}>
          <OAuthClientsTab level="application" />
        </Suspense>
      )}
    </>
  );
}

function GeneralTab({
  appId,
  application,
}: {
  appId: string;
  application: {
    name: string;
    isDefault: boolean;
    settings?: { allowedRedirectDomains?: string[] };
  };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const updateMutation = useUpdateApplication();
  const deleteMutation = useDeleteApplication();

  const domains = application.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const activeDomains = editedDomains ?? domains;

  const { register, handleSubmit, showError } = useAppForm<SettingsFormData>({
    values: { name: application.name },
  });

  const onSubmit = (data: SettingsFormData) => {
    updateMutation.mutate({
      id: appId,
      data: { name: data.name.trim(), settings: { allowedRedirectDomains: activeDomains } },
    });
  };

  return (
    <>
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
