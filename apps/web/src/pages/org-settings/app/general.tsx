// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus, X } from "lucide-react";
import { usePermissions } from "../../../hooks/use-permissions";
import { ConfirmModal } from "../../../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { useSpace, useUpdateSpace, useDeleteSpace } from "../../../hooks/use-spaces";
import { useCurrentSpaceId } from "../../../hooks/use-current-space";
import { LoadingState, ErrorState, EmptyState } from "../../../components/page-states";
import { Spinner } from "../../../components/spinner";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { Label } from "@appstrate/ui/components/label";
import { SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { RoleCatalogState } from "../../../components/role-catalog-state";
import { SpaceRoleSelect } from "../../../components/space-role-select";
import { useSpaceRoleOptions, type SpaceRolePreset } from "../../../hooks/use-roles";
import type { components } from "../../../api/client";
import { SettingsGroup, SettingRow } from "../../../components/settings/setting-row";
import { InlineTextSetting } from "../../../components/settings/inline-text-setting";
import { getErrorMessage } from "@appstrate/core/errors";
import { toast } from "sonner";

type SpaceVisibility = components["schemas"]["SpaceObject"]["visibility"];

export function OrgSettingsAppGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const spaceId = useCurrentSpaceId();
  const { data: application, isLoading, error } = useSpace(spaceId ?? "");

  if (!can("org:read")) return null;
  if (!spaceId) return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!application) return <ErrorState />;

  return <GeneralForm spaceId={spaceId} application={application} />;
}

function GeneralForm({
  spaceId,
  application,
}: {
  spaceId: string;
  application: {
    name: string;
    isDefault: boolean;
    settings?: { allowedRedirectDomains?: string[] };
    visibility: SpaceVisibility;
    default_role: SpaceRolePreset;
  };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const updateMutation = useUpdateSpace();
  const deleteMutation = useDeleteSpace();

  const domains = application.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [editedVisibility, setEditedVisibility] = useState<SpaceVisibility | null>(null);
  const [editedDefaultRole, setEditedDefaultRole] = useState<SpaceRolePreset | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState<"name" | "domains" | "visibility" | "defaultRole" | null>(
    null,
  );
  const activeDomains = editedDomains ?? domains;
  const activeVisibility = editedVisibility ?? application.visibility;
  const activeDefaultRole = editedDefaultRole ?? application.default_role;

  // The assignable presets come from the org's role catalogue, which a space
  // admin may read without owning it.
  const {
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(spaceId);
  const presetOptions = (roles ?? [])
    .filter((role) => role.kind === "preset")
    .map((role) => ({ value: role.key, label: t(`roles.preset.${role.key}`) }));

  // Each control commits on its own — "the control IS the setting". The Save
  // button that used to sit under this form was the last one in the settings
  // surfaces, and it made the workspace the one screen where a change was not
  // a change until you pressed something else.
  const save = (
    patch: {
      name?: string;
      domains?: string[];
      visibility?: SpaceVisibility;
      default_role?: SpaceRolePreset;
    },
    field: "name" | "domains" | "visibility" | "defaultRole",
  ) => {
    setSaving(field);
    updateMutation.mutate(
      {
        params: { path: { id: spaceId } },
        body: {
          name: (patch.name ?? application.name).trim(),
          settings: { allowedRedirectDomains: patch.domains ?? activeDomains },
          visibility: patch.visibility ?? activeVisibility,
          default_role: patch.default_role ?? activeDefaultRole,
        },
      },
      {
        onError: (error) => {
          toast.error(t("error.prefix", { message: getErrorMessage(error) }));
        },
        onSettled: () => setSaving(null),
      },
    );
  };

  const commitVisibility = (next: SpaceVisibility) => {
    setEditedVisibility(next);
    save({ visibility: next }, "visibility");
  };

  const commitDefaultRole = (next: SpaceRolePreset) => {
    setEditedDefaultRole(next);
    save({ default_role: next }, "defaultRole");
  };

  const commitDomains = (next: string[]) => {
    // Empty rows are the residue of editing, not a value: a domain nobody typed
    // has no business being sent, and an empty string is not one.
    const cleaned = next.map((d) => d.trim()).filter(Boolean);
    setEditedDomains(next);
    save({ domains: cleaned }, "domains");
  };

  return (
    <>
      <SettingsGroup title={t("applications.settingsTitle")}>
        <SettingRow
          variant="field"
          label={t("applications.nameLabel")}
          status={saving === "name" && <Spinner />}
        >
          <InlineTextSetting
            value={application.name}
            disabled={updateMutation.isPending}
            aria-label={t("applications.nameLabel")}
            placeholder={t("applications.namePlaceholder")}
            onCommit={(name) => save({ name }, "name")}
          />
        </SettingRow>

        <SettingRow
          variant="field"
          label={t("applications.redirectDomains")}
          description={t("applications.redirectDomainsHint")}
          status={saving === "domains" && <Spinner />}
        >
          <div className="flex w-full flex-col gap-2">
            {activeDomains.map((domain, index) => (
              <div key={index} className="flex w-full items-center gap-2">
                <Input
                  type="text"
                  value={domain}
                  disabled={updateMutation.isPending}
                  className="min-w-0 flex-1"
                  onChange={(e) =>
                    setEditedDomains((prev) =>
                      (prev ?? domains).map((d, i) => (i === index ? e.target.value : d)),
                    )
                  }
                  // Commits when you leave the field, like every other setting
                  // here; Enter is the same answer for a single-line input.
                  onBlur={() => commitDomains(activeDomains)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  placeholder="example.com"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={updateMutation.isPending}
                  aria-label={t("btn.delete", { ns: "common" })}
                  onClick={() => commitDomains(activeDomains.filter((_, i) => i !== index))}
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            {/* Adding one does not save: an empty row is not a domain. It
                commits when the field it opened is filled and left. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={updateMutation.isPending}
              className="self-start"
              onClick={() => setEditedDomains([...(activeDomains ?? []), ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("applications.addDomain")}
            </Button>
          </div>
        </SettingRow>

        {/* Who reaches this space without an explicit membership row (RBAC
            spec §3.1). Radios rather than a select: the three answers differ
            in consequence, not in degree, and each needs its sentence. */}
        <SettingRow
          variant="field"
          label={t("spaces.visibilityLabel")}
          description={t("spaces.visibilityHint")}
          status={saving === "visibility" && <Spinner />}
        >
          <div className="flex w-full flex-col gap-3">
            <RadioGroup
              value={activeVisibility}
              onValueChange={(value) => commitVisibility(value as SpaceVisibility)}
              disabled={application.isDefault || updateMutation.isPending}
              aria-label={t("spaces.visibilityLabel")}
            >
              {SPACE_VISIBILITIES.map((value) => (
                <div key={value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={value}
                    id={`space-visibility-${value}`}
                    className="mt-1 shrink-0"
                  />
                  <Label
                    htmlFor={`space-visibility-${value}`}
                    className="flex min-w-0 flex-col items-start gap-1"
                  >
                    <span>{t(`spaces.visibility.${value}`)}</span>
                    <span className="text-muted-foreground text-sm leading-relaxed font-normal">
                      {t(`spaces.visibilityDesc.${value}`)}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
            <p className="text-muted-foreground text-xs">{t("spaces.adminAccessHint")}</p>
            {application.isDefault && (
              <p className="text-muted-foreground text-xs">{t("spaces.visibilityDefaultLocked")}</p>
            )}
          </div>
        </SettingRow>

        {/* Only an `open` space has implicit members, so only it has a preset
            to give them. */}
        {activeVisibility === "open" && (
          <SettingRow
            variant="field"
            label={t("spaces.defaultRoleLabel")}
            description={t("spaces.defaultRoleHint")}
            status={saving === "defaultRole" && <Spinner />}
          >
            <div className="flex w-full flex-col gap-2">
              <SpaceRoleSelect
                id="space-default-role"
                className="w-full sm:w-[240px]"
                value={activeDefaultRole}
                options={presetOptions}
                fallbackLabel={t(`roles.preset.${activeDefaultRole}`)}
                disabled={updateMutation.isPending}
                onValueChange={(value) => commitDefaultRole(value as SpaceRolePreset)}
              />
              <RoleCatalogState
                isLoading={rolesLoading}
                rolesKnown={rolesKnown}
                error={rolesError}
                refetch={() => void refetchRoles()}
                emptyMessage={presetOptions.length === 0 ? t("spaces.noAssignablePresets") : null}
              />
              <p className="text-muted-foreground text-xs">{t("spaces.defaultRoleImpact")}</p>
            </div>
          </SettingRow>
        )}
      </SettingsGroup>

      {/* The danger zone is a settings group like any other. Its exception is
          the CONTROL — a button that opens a confirm — which is what the row
          pattern says a destructive setting looks like, rather than a red-bordered
          card that reads as a different kind of screen. */}
      {!application.isDefault && (
        <SettingsGroup title={t("applications.dangerZone")}>
          <SettingRow
            variant="action"
            label={t("applications.deleteTitle")}
            description={t("applications.deleteDesc")}
          >
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {deleteMutation.isPending ? t("applications.deleting") : t("btn.delete")}
            </Button>
          </SettingRow>
        </SettingsGroup>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("applications.deleteConfirm", { name: application.name })}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(
            { params: { path: { id: spaceId } } },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                navigate("/org-settings/spaces", { state: location.state });
              },
            },
          );
        }}
      />
    </>
  );
}
