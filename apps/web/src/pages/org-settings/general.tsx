// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@appstrate/core/errors";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { EmptyState } from "../../components/page-states";
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

  const { copied: mcpCopied, copy: copyMcp } = useCopyToClipboard();

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateNameMutation = $api.useMutation("put", "/api/orgs/{orgId}", {
    onSuccess: () => {
      // The org list lives under the legacy ["orgs"] key (see use-org.ts).
      void queryClient.invalidateQueries({ queryKey: ["orgs"] });
      setEditingName(false);
    },
    onError: (err) => {
      toast.error(t("error.prefix", { message: getErrorMessage(err) }));
    },
  });

  const deleteOrgMutation = $api.useMutation("delete", "/api/orgs/{orgId}", {
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["orgs"] });
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

  const mcpCommand = `claude mcp add --transport http appstrate-${currentOrg.slug} ${window.location.origin}/api/mcp/o/${currentOrg.id}`;

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
        <p className="text-muted-foreground mt-1 text-sm">{t("orgSettings.mcpDesc")}</p>
        <div className="border-border bg-muted/50 mt-3 flex items-center gap-2 rounded-md border px-3 py-2">
          <code className="text-foreground flex-1 font-mono text-xs break-all select-all">
            {mcpCommand}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="text-primary shrink-0 text-xs hover:underline"
            aria-label={t("btn.copy", { ns: "common" })}
            onClick={() => copyMcp(mcpCommand)}
          >
            {mcpCopied ? t("btn.copied", { ns: "common" }) : t("btn.copy", { ns: "common" })}
          </Button>
        </div>
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
