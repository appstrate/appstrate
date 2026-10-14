// SPDX-License-Identifier: Apache-2.0

import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Building, HardDrive, Smile, Trash2, Upload } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { canLeaveOrg } from "@appstrate/shared-types";
import { $api } from "../../api/client";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { useOrg, useOrgDetail } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useCanCreateOrg } from "../../hooks/use-auth";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { USAGE_WARN } from "../../lib/usage-severity";
import { UsageBar } from "../../components/usage-bar";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { SaveFeedback } from "../../components/settings/save-feedback";
import { fieldWriteState } from "../../lib/field-write-state";
import { PersonalCredentialsSetting } from "../../components/settings/personal-credentials-setting";
import { EmptyState } from "../../components/page-states";
import { orgKeys } from "../../lib/query-keys";
import { useViewAsHeader } from "../../stores/view-as-store";
import { toast } from "sonner";
import { OrganizationAvatar } from "../../components/organization-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { storableLogo, type OrgLogo } from "../../lib/org-logo";

const ORGANIZATION_EMOJIS = ["⚡️", "🚜", "🏢", "🧠", "✨", "🔵", "🟣", "🟠"];
const MAX_LOGO_SOURCE_BYTES = 5 * 1024 * 1024;

function encodeWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("logo_processing"))),
      "image/webp",
      0.82,
    ),
  );
}

async function normalizeOrganizationLogo(file: File): Promise<Blob> {
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
      const logo = storableLogo(await encodeWebp(canvas));
      if (logo) return logo;
    }
  } finally {
    bitmap.close();
  }

  throw new Error("logo_processing");
}

export function OrgSettingsGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { currentOrg, orgs, forgetOrg } = useOrg();
  const { can, orgRole } = usePermissions();
  const canCreateOrg = useCanCreateOrg();
  const { data: orgSettings } = useOrgSettings();
  const updateSettingsMutation = useUpdateOrgSettings();
  // Every member opens this page (leaving lives here); each change is drawn
  // only for whoever holds its permission.
  const canUpdateOrg = can("org:update");
  const canSettings = can("org:settings");
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  // Single source of truth for the storage gauge (shared with billing +
  // files). `limitBytes` null = unlimited (per-org override ?? global quota).
  const {
    storage,
    limitBytes: storageLimit,
    percent: storagePercent,
    usageLabel,
  } = useOrgStorage();
  // The heads-up banner fires at the shared WARN threshold — the same point the
  // bar turns yellow — so the user is warned well before uploads get rejected.
  const storageNearLimit = storagePercent !== null && storagePercent >= USAGE_WARN;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [processingLogo, setProcessingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leaveHintId = useId();

  // Owners always get the member list.
  const { data: orgDetail } = useOrgDetail();
  const ownerCount = orgDetail?.members?.filter((m) => m.role === "owner").length ?? 0;
  // Under a preview `orgRole` is the persona's, not the real membership.
  const previewing = useViewAsHeader() !== null;
  const lastOwner = !!orgDetail && orgRole !== null && !canLeaveOrg({ role: orgRole, ownerCount });
  const canLeave = orgRole !== null && !previewing && !lastOwner;
  // An only member has nobody to name owner: point to delete instead.
  const leaveHint = previewing
    ? t("orgSettings.leavePreview")
    : lastOwner
      ? orgDetail?.members?.length === 1
        ? t("orgSettings.leaveOnlyMember")
        : t("orgSettings.leaveLastOwner")
      : t("orgSettings.leaveOrgDesc");

  const updateNameMutation = $api.useMutation("patch", "/api/orgs/{orgId}", {
    onSuccess: () => {
      // The org list lives under the legacy ["orgs"] key (see use-org.ts).
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
    },
  });

  const uploadLogoMutation = $api.useMutation("put", "/api/orgs/{orgId}/logo", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
    },
  });

  // The logo is written by two requests: an image upload, or an emoji / removal patch.
  // Each starts by clearing the other's state, so the feedback is the latest write's.
  const logoWrite = uploadLogoMutation.isIdle
    ? fieldWriteState(updateNameMutation, "logo")
    : {
        pending: uploadLogoMutation.isPending,
        success: uploadLogoMutation.isSuccess,
        error: uploadLogoMutation.isError,
      };
  const logoBusy = updateNameMutation.isPending || uploadLogoMutation.isPending || processingLogo;
  const patchLogo = (logo: Extract<OrgLogo, { kind: "emoji" }> | null) => {
    if (!orgId) return;
    uploadLogoMutation.reset();
    updateNameMutation.mutate({ params: { path: { orgId } }, body: { logo } });
  };
  const nameWrite = fieldWriteState(updateNameMutation, "name");

  // No reload needed: `forgetOrg` moves the selection off the gone org.
  const exitOrg = (leftOrgId: string) => {
    forgetOrg(leftOrgId);
    navigate("/", { replace: true });
  };

  const deleteOrgMutation = $api.useMutation("delete", "/api/orgs/{orgId}", {
    onSuccess: (_data, { params }) => exitOrg(params.path.orgId),
  });

  const leaveOrgMutation = $api.useMutation("post", "/api/orgs/{orgId}/leave", {
    onSuccess: (_data, { params }) => exitOrg(params.path.orgId),
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
          description={canUpdateOrg ? t("orgSettings.logoDescription") : undefined}
          status={<SaveFeedback {...logoWrite} pending={logoWrite.pending || processingLogo} />}
        >
          <div className="flex items-center gap-3">
            <OrganizationAvatar org={currentOrg} className="size-16 rounded-xl text-2xl" />
            {canUpdateOrg && (
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
                      uploadLogoMutation.mutate({
                        params: { path: { orgId } },
                        body: logo,
                        headers: { "Content-Type": "image/webp" },
                        bodySerializer: (body) => body,
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
                  disabled={logoBusy}
                  onClick={() => logoInputRef.current?.click()}
                >
                  <Upload />
                  {t("orgSettings.logoUpload")}
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={logoBusy}>
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
                          onClick={() => patchLogo({ kind: "emoji", emoji })}
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
                    disabled={logoBusy}
                    onClick={() => patchLogo(null)}
                  >
                    <Trash2 />
                    {t("orgSettings.logoRemove")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </SettingRow>
        <SettingRow
          variant="field"
          label={t("orgSettings.nameLabel")}
          description={currentOrg.slug}
          status={<SaveFeedback {...nameWrite} />}
        >
          {canUpdateOrg ? (
            <InlineTextSetting
              value={currentOrg.name}
              disabled={nameWrite.pending}
              aria-label={t("orgSettings.nameLabel")}
              onCommit={(name) => {
                if (!orgId) return;
                updateNameMutation.mutate({ params: { path: { orgId } }, body: { name } });
              }}
            />
          ) : (
            <span className="text-sm">{currentOrg.name}</span>
          )}
        </SettingRow>
      </SettingsGroup>

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
                <span className="text-muted-foreground text-sm">{usageLabel}</span>
              </div>
            </div>

            {storageLimit !== null && (
              <div className="mt-4">
                <UsageBar percent={storagePercent ?? 0} label={t("orgStorage.title")} />
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

      {/* The restrict-package-copy setting, in this app's own grammar: a
          labelled switch in a SettingsGroup, not a card with an
          Activer/Désactiver button. Collaborator SSO lives on its own page
          (`oauth.tsx`) and the MCP endpoint under Préférences; repeating them
          here would be a second place to change one setting. */}
      {canSettings && (
        <>
          <SettingsGroup title={t("orgSettings.distributionTitle")}>
            <SettingRow
              variant="toggle"
              label={
                <Label htmlFor="restrict-package-copy" className="cursor-pointer">
                  {t("orgSettings.restrictCopyTitle")}
                </Label>
              }
              description={t("orgSettings.restrictCopyDesc")}
              status={
                <SaveFeedback
                  {...fieldWriteState(updateSettingsMutation, "restrict_package_copy")}
                />
              }
            >
              <Switch
                id="restrict-package-copy"
                checked={orgSettings?.restrict_package_copy ?? false}
                disabled={updateSettingsMutation.isPending}
                onCheckedChange={(checked) =>
                  updateSettingsMutation.mutate({
                    params: { path: { orgId: currentOrg.id } },
                    body: { restrict_package_copy: checked === true },
                  })
                }
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={t("models.tabTitle")}>
            <PersonalCredentialsSetting />
          </SettingsGroup>
        </>
      )}

      {/* Same danger zone as the workspace's: a settings group whose rows hold
          a button that opens a confirm. Leaving is offered to every member —
          disabled, with the reason as its description, when the server would
          refuse it (the last owner) or when the role on screen is a preview. */}
      <SettingsGroup title={t("orgSettings.dangerZone")}>
        <SettingRow
          variant="action"
          label={t("orgSettings.leaveOrg")}
          description={<span id={leaveHintId}>{leaveHint}</span>}
        >
          <Button
            data-testid="leave-org-button"
            aria-describedby={leaveHintId}
            variant="destructive"
            disabled={!canLeave || leaveOrgMutation.isPending}
            onClick={() => setConfirmLeave(true)}
          >
            {leaveOrgMutation.isPending ? t("orgSettings.leaving") : t("orgSettings.leaveOrg")}
          </Button>
        </SettingRow>
        {can("org:delete") && (
          <SettingRow
            variant="action"
            label={t("orgSettings.deleteOrg")}
            description={t("orgSettings.deleteOrgDesc")}
          >
            <Button
              data-testid="delete-org-button"
              variant="destructive"
              disabled={deleteOrgMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              {deleteOrgMutation.isPending ? t("orgSettings.deleting") : t("btn.delete")}
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("orgSettings.deleteOrg")}
        description={t("orgSettings.deleteConfirm", { name: currentOrg.name })}
        isPending={deleteOrgMutation.isPending}
        onConfirm={() => deleteOrgMutation.mutate({ params: { path: { orgId: currentOrg.id } } })}
      />

      <ConfirmModal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={t("orgSettings.leaveOrg")}
        description={t("orgSettings.leaveConfirm", { name: currentOrg.name })}
        confirmLabel={t("orgSettings.leaveOrg")}
        isPending={leaveOrgMutation.isPending}
        onConfirm={() => leaveOrgMutation.mutate({ params: { path: { orgId: currentOrg.id } } })}
      >
        <p className="text-muted-foreground mt-2 text-sm">
          {t("orgSettings.leaveConfirmPersonalSpace")}
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("orgSettings.leaveConfirmConnections")}
        </p>
        {orgs.length === 1 && (
          <p className="mt-2 text-sm font-medium">
            {canCreateOrg
              ? t("orgSettings.leaveLastOrgCreate")
              : t("orgSettings.leaveLastOrgWaiting")}
          </p>
        )}
      </ConfirmModal>
    </>
  );
}
