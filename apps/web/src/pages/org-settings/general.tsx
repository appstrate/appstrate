// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building, HardDrive, AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { getErrorMessage } from "@appstrate/core/errors";
import { formatBytes } from "@appstrate/core/format";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { getUsageBarColor, USAGE_CRITICAL } from "../../lib/usage-severity";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { EmptyState } from "../../components/page-states";
import { McpClientConnect } from "../../components/org-settings/mcp-client-connect";
import { orgKeys } from "../../lib/query-keys";
import { toast } from "sonner";

export function OrgSettingsGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { isOwner, isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const { data: orgSettings } = useOrgSettings();
  const updateSettingsMutation = useUpdateOrgSettings();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  // Single source of truth for the storage gauge (shared with billing +
  // documents). `limitBytes` null = unlimited (per-org override ?? global quota).
  const { storage, limitBytes: storageLimit, percent: storagePercent } = useOrgStorage();
  const storageNearLimit = storagePercent !== null && storagePercent >= USAGE_CRITICAL;

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateNameMutation = $api.useMutation("put", "/api/orgs/{orgId}", {
    onSuccess: () => {
      // The org list lives under the legacy ["orgs"] key (see use-org.ts).
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
      setEditingName(false);
    },
    onError: (err) => {
      toast.error(t("error.prefix", { message: getErrorMessage(err) }));
    },
  });

  const deleteOrgMutation = $api.useMutation("delete", "/api/orgs/{orgId}", {
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: orgKeys.all });
      navigate("/");
      window.location.reload();
    },
    onError: (err) => {
      toast.error(t("error.prefix", { message: getErrorMessage(err) }));
    },
  });

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} icon={Building} />;
  }

  const handleSaveName = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || !orgId) return;
    updateNameMutation.mutate({ params: { path: { orgId } }, body: { name: trimmed } });
  };

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("orgSettings.orgTitle")}
      </div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            {editingName ? (
              <form onSubmit={handleSaveName} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={currentOrg.name}
                  autoFocus
                />
                <Button type="submit" disabled={updateNameMutation.isPending}>
                  {updateNameMutation.isPending ? <Spinner /> : t("btn.save")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditingName(false)}>
                  {t("btn.cancel")}
                </Button>
              </form>
            ) : (
              <>
                <h3 className="text-[0.95rem] font-semibold">{currentOrg.name}</h3>
                <span className="text-muted-foreground text-sm">{currentOrg.slug}</span>
              </>
            )}
          </div>
          {isAdmin && !editingName && (
            <Button
              variant="outline"
              onClick={() => {
                setNewName(currentOrg.name);
                setEditingName(true);
              }}
            >
              {t("btn.edit")}
            </Button>
          )}
        </div>
      </div>

      {storage && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("orgStorage.section")}
          </div>
          <div className="border-border bg-card mb-4 rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <HardDrive size={18} className="text-muted-foreground shrink-0" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("orgStorage.title")}</h3>
                <span className="text-muted-foreground text-sm">
                  {storage.effective_limit_bytes === null
                    ? t("orgStorage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
                    : t("orgStorage.usedOfLimit", {
                        used: formatBytes(storage.used_bytes),
                        limit: formatBytes(storage.effective_limit_bytes),
                      })}
                </span>
              </div>
            </div>

            {storageLimit !== null && (
              <div className="mt-4">
                <div
                  className="bg-muted h-2 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuenow={storagePercent ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={t("orgStorage.title")}
                >
                  <div
                    className={`h-full rounded-full transition-all ${getUsageBarColor(storagePercent ?? 0)}`}
                    style={{ width: `${storagePercent ?? 0}%` }}
                  />
                </div>
                <div className="text-muted-foreground mt-1 text-right text-xs tabular-nums">
                  {t("orgStorage.percentUsed", { percent: storagePercent ?? 0 })}
                </div>
                {storageNearLimit && (
                  <Alert variant="warning" className="mt-3">
                    <AlertTriangle size={16} />
                    <AlertDescription>{t("orgStorage.nearLimitWarning")}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {isAdmin && features.oidc && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("orgSettings.advancedSection")}
          </div>
          <div className="border-border bg-card mb-4 rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("orgSettings.dashboardSsoTitle")}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("orgSettings.dashboardSsoDesc")}
                </span>
              </div>
              <Button
                variant={orgSettings?.dashboard_sso_enabled ? "default" : "outline"}
                disabled={updateSettingsMutation.isPending}
                onClick={() =>
                  updateSettingsMutation.mutate(
                    {
                      params: { path: { orgId: currentOrg.id } },
                      body: { dashboard_sso_enabled: !orgSettings?.dashboard_sso_enabled },
                    },
                    {
                      onSuccess: (data) => {
                        toast.success(
                          data.dashboard_sso_enabled
                            ? t("orgSettings.dashboardSsoEnabled")
                            : t("orgSettings.dashboardSsoDisabled"),
                        );
                      },
                      onError: (err) => {
                        toast.error(t("error.prefix", { message: getErrorMessage(err) }));
                      },
                    },
                  )
                }
              >
                {updateSettingsMutation.isPending ? (
                  <Spinner />
                ) : orgSettings?.dashboard_sso_enabled ? (
                  t("orgSettings.dashboardSsoDisable")
                ) : (
                  t("orgSettings.dashboardSsoEnable")
                )}
              </Button>
            </div>
          </div>
        </>
      )}

      <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
        {t("orgSettings.mcpSection")}
      </div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <h3 className="text-sm font-semibold">{t("orgSettings.mcpTitle")}</h3>
        <p className="text-muted-foreground mt-1 mb-3 text-sm">{t("orgSettings.mcpDesc")}</p>
        <McpClientConnect
          serverName={`appstrate-${currentOrg.slug}`}
          url={`${window.location.origin}/api/mcp/o/${currentOrg.id}`}
        />
      </div>

      {isOwner && (
        <>
          <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
            {t("orgSettings.dangerZone")}
          </div>
          <div className="border-destructive bg-card rounded-lg border p-5">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("orgSettings.deleteOrg")}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("orgSettings.deleteOrgDesc")}
                </span>
              </div>
              <Button
                variant="destructive"
                disabled={deleteOrgMutation.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                {deleteOrgMutation.isPending ? t("orgSettings.deleting") : t("btn.delete")}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("orgSettings.deleteOrg")}
        description={t("orgSettings.deleteConfirm", { name: currentOrg.name })}
        isPending={deleteOrgMutation.isPending}
        onConfirm={() => deleteOrgMutation.mutate({ params: { path: { orgId: currentOrg.id } } })}
      />
    </>
  );
}
