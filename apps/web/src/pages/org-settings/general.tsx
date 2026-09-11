// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Building, HardDrive, Smile, Trash2, Upload } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { getErrorMessage } from "@appstrate/core/errors";
import { formatBytes } from "@appstrate/core/format";
import { $api } from "../../api/client";
import { Switch } from "@appstrate/ui/components/switch";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { getUsageBarColor, USAGE_WARN } from "../../lib/usage-severity";
import { useAppConfig } from "../../hooks/use-app-config";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { EmptyState } from "../../components/page-states";
import { orgKeys } from "../../lib/query-keys";
import { toast } from "sonner";
import { OrganizationAvatar } from "../../components/organization-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";

const ORGANIZATION_EMOJIS = ["⚡️", "🚜", "🏢", "🧠", "✨", "🔵", "🟣", "🟠"];
const MAX_LOGO_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_LENGTH = 180_000;

async function normalizeOrganizationLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("logo_file_type");
  if (file.size > MAX_LOGO_SOURCE_BYTES) throw new Error("logo_file_size");

  const bitmap = await createImageBitmap(file);
  try {
    const crop = Math.min(bitmap.width, bitmap.height);
    const sourceX = (bitmap.width - crop) / 2;
    const sourceY = (bitmap.height - crop) / 2;

    for (const size of [192, 160, 128, 96]) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("logo_processing");
      context.drawImage(bitmap, sourceX, sourceY, crop, crop, 0, 0, size, size);
      const encoded = canvas.toDataURL("image/webp", 0.82);
      if (encoded.length <= MAX_LOGO_LENGTH) return encoded;
    }
  } finally {
    bitmap.close();
  }

  throw new Error("logo_processing");
}

export function OrgSettingsGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const canUpdateOrg = can("org:update");
  const { features } = useAppConfig();
  const { data: orgSettings } = useOrgSettings();
  const updateSettingsMutation = useUpdateOrgSettings();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  // Single source of truth for the storage gauge (shared with billing +
  // files). `limitBytes` null = unlimited (per-org override ?? global quota).
  const { storage, limitBytes: storageLimit, percent: storagePercent } = useOrgStorage();
  // The heads-up banner fires at the shared WARN threshold — the same point the
  // bar turns yellow — so the user is warned well before uploads get rejected.
  const storageNearLimit = storagePercent !== null && storagePercent >= USAGE_WARN;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [processingLogo, setProcessingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const updateNameMutation = $api.useMutation("put", "/api/orgs/{orgId}", {
    onSuccess: () => {
      // The org list lives under the legacy ["orgs"] key (see use-org.ts).
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
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

  return (
    <>
      <SettingsGroup title={t("orgSettings.orgTitle")}>
        <SettingRow
          variant="field"
          label={t("orgSettings.logoLabel")}
          description={t("orgSettings.logoDescription")}
          status={(updateNameMutation.isPending || processingLogo) && <Spinner />}
        >
          <div className="flex items-center gap-3">
            <OrganizationAvatar
              name={currentOrg.name}
              logo={currentOrg.logo}
              className="size-16 rounded-xl text-2xl"
            />
            <div className="flex flex-wrap gap-2">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="sr-only"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file || !orgId) return;
                  setProcessingLogo(true);
                  try {
                    const logo = await normalizeOrganizationLogo(file);
                    updateNameMutation.mutate({
                      params: { path: { orgId } },
                      body: { logo },
                    });
                  } catch {
                    toast.error(t("orgSettings.logoError"));
                  } finally {
                    setProcessingLogo(false);
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canUpdateOrg || updateNameMutation.isPending || processingLogo}
                onClick={() => logoInputRef.current?.click()}
              >
                <Upload />
                {t("orgSettings.logoUpload")}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canUpdateOrg || updateNameMutation.isPending || processingLogo}
                  >
                    <Smile />
                    {t("orgSettings.logoEmoji")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-2">
                  <div className="grid grid-cols-4 gap-1">
                    {ORGANIZATION_EMOJIS.map((emoji) => (
                      <Button
                        key={emoji}
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-lg"
                        aria-label={t("orgSettings.logoUseEmoji", { emoji })}
                        onClick={() => {
                          if (!orgId) return;
                          updateNameMutation.mutate({
                            params: { path: { orgId } },
                            body: { logo: `emoji:${emoji}` },
                          });
                        }}
                      >
                        {emoji}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {currentOrg.logo && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canUpdateOrg || updateNameMutation.isPending || processingLogo}
                  onClick={() => {
                    if (!orgId) return;
                    updateNameMutation.mutate({
                      params: { path: { orgId } },
                      body: { logo: null },
                    });
                  }}
                >
                  <Trash2 />
                  {t("orgSettings.logoRemove")}
                </Button>
              )}
            </div>
          </div>
        </SettingRow>
        <SettingRow
          variant="field"
          label={t("orgSettings.nameLabel")}
          description={currentOrg.slug}
          status={updateNameMutation.isPending && <Spinner />}
        >
          <InlineTextSetting
            value={currentOrg.name}
            disabled={!canUpdateOrg || updateNameMutation.isPending}
            aria-label={t("orgSettings.nameLabel")}
            onCommit={(name) => {
              if (!orgId) return;
              updateNameMutation.mutate({ params: { path: { orgId } }, body: { name } });
            }}
          />
        </SettingRow>
      </SettingsGroup>

      {/* Dashboard SSO — who may sign in to the dashboard through the org's own
          identity provider. Behind `org:settings` (not `org:update`): an admin
          administers the org without being able to re-slug it. */}
      {can("org:settings") && features.oidc && (
        <SettingsGroup title={t("orgSettings.advancedSection")}>
          <SettingRow
            variant="toggle"
            label={t("orgSettings.dashboardSsoTitle")}
            description={t("orgSettings.dashboardSsoDesc")}
            status={updateSettingsMutation.isPending && <Spinner />}
          >
            <Switch
              checked={Boolean(orgSettings?.dashboard_sso_enabled)}
              disabled={updateSettingsMutation.isPending}
              aria-label={t("orgSettings.dashboardSsoTitle")}
              onCheckedChange={(next) =>
                updateSettingsMutation.mutate(
                  {
                    params: { path: { orgId: currentOrg.id } },
                    body: { dashboard_sso_enabled: next },
                  },
                  {
                    onSuccess: (data) =>
                      toast.success(
                        data.dashboard_sso_enabled
                          ? t("orgSettings.dashboardSsoEnabled")
                          : t("orgSettings.dashboardSsoDisabled"),
                      ),
                    onError: (err) =>
                      toast.error(t("error.prefix", { message: getErrorMessage(err) })),
                  },
                )
              }
            />
          </SettingRow>
        </SettingsGroup>
      )}

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

      {can("org:delete") && (
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
