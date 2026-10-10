// SPDX-License-Identifier: Apache-2.0

import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Building, HardDrive, Smile, Trash2, Upload } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Label } from "@appstrate/ui/components/label";
import { Switch } from "@appstrate/ui/components/switch";
import { formatBytes } from "../../lib/format-bytes";
import { canLeaveOrg } from "@appstrate/shared-types";
import { $api } from "../../api/client";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { InlineTextSetting } from "../../components/settings/inline-text-setting";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useCanCreateOrg } from "../../hooks/use-auth";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { useOrgSettings, useUpdateOrgSettings } from "../../hooks/use-org-settings";
import { getUsageBarColor, USAGE_WARN } from "../../lib/usage-severity";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { EmptyState } from "../../components/page-states";
import { orgKeys } from "../../lib/query-keys";
import { useViewAsHeader } from "../../stores/view-as-store";
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
  const { currentOrg, orgs, forgetOrg } = useOrg();
  const { can, orgRole } = usePermissions();
  const canCreateOrg = useCanCreateOrg();
  const { data: orgSettings } = useOrgSettings();
  // Unknown until the settings load: the toggle then reads neither as on nor off.
  const personalModelCredentialsAllowed = orgSettings
    ? orgSettings.personal_model_credentials !== false
    : undefined;
  const updateSettingsMutation = useUpdateOrgSettings();
  const canUpdateOrg = can("org:update");
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
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leaveHintId = useId();

  // Shares `useOrgStorage`'s cache entry; owners always get the member list.
  const { data: orgDetail } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );
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

      {/* Main's restrict-package-copy setting (#1437), in this app's own
          grammar: a labelled switch in a SettingsGroup, not a card with an
          Activer/Désactiver button. The two other blocks main renders here are
          NOT carried over — collaborator SSO lives on its own page (`oauth.tsx`)
          and the MCP endpoint under Préférences, so repeating them here would
          be a second place to change one setting. */}
      <SettingsGroup title={t("orgSettings.distributionTitle")}>
        <SettingRow
          variant="toggle"
          label={
            <Label htmlFor="restrict-package-copy" className="cursor-pointer">
              {t("orgSettings.restrictCopyTitle")}
            </Label>
          }
          description={t("orgSettings.restrictCopyDesc")}
          status={updateSettingsMutation.isPending && <Spinner />}
        >
          <Switch
            id="restrict-package-copy"
            checked={orgSettings?.restrict_package_copy ?? false}
            disabled={!can("org:settings") || updateSettingsMutation.isPending}
            onCheckedChange={(checked) =>
              updateSettingsMutation.mutate({
                params: { path: { orgId: currentOrg.id } },
                body: { restrict_package_copy: checked === true },
              })
            }
          />
        </SettingRow>
      </SettingsGroup>

      {/* Opt-out: absent means allowed. The switch reads neither on nor off until
          the settings load, so a click can never send a value read off a default. */}
      <SettingsGroup title={t("models.tabTitle")}>
        <SettingRow
          variant="toggle"
          label={
            <Label htmlFor="personal-model-credentials" className="cursor-pointer">
              {t("orgSettings.personalModelCredentialsTitle")}
            </Label>
          }
          description={t("orgSettings.personalModelCredentialsDesc")}
          status={updateSettingsMutation.isPending && <Spinner />}
        >
          <Switch
            id="personal-model-credentials"
            checked={personalModelCredentialsAllowed ?? false}
            disabled={!can("org:settings") || !orgSettings || updateSettingsMutation.isPending}
            onCheckedChange={(checked) =>
              updateSettingsMutation.mutate(
                {
                  params: { path: { orgId: currentOrg.id } },
                  body: { personal_model_credentials: checked === true },
                },
                {
                  // The flag changes which models each member pays for and which
                  // credentials serve a call: refresh both lists.
                  onSuccess: () => {
                    void queryClient.invalidateQueries({ queryKey: ["get", "/api/models"] });
                    void queryClient.invalidateQueries({
                      queryKey: ["get", "/api/model-provider-credentials"],
                    });
                  },
                },
              )
            }
          />
        </SettingRow>
      </SettingsGroup>

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
