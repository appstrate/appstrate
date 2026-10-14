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
import { SaveFeedback } from "../../../components/settings/save-feedback";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { Label } from "@appstrate/ui/components/label";
import { SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { RoleCatalogState } from "../../../components/role-catalog-state";
import { SpaceRoleSelect } from "../../../components/space-role-select";
import { useSpaceRoleOptions, type SpaceRolePreset } from "../../../hooks/use-roles";
import type { components } from "../../../api/client";
import { SettingsGroup, SettingRow } from "../../../components/settings/setting-row";
import { InlineTextSetting } from "../../../components/settings/inline-text-setting";
import { ApiError } from "../../../api/errors";
import { toastError } from "../../../lib/mutation-error";
import {
  domainsChanged,
  spaceUpdateBody,
  visibilityChangeNeedsConfirmation,
  type SpaceSettingChange,
} from "../../../lib/space-update-body";

type SpaceVisibility = components["schemas"]["SpaceObject"]["visibility"];

export function OrgSettingsAppGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const spaceId = useCurrentSpaceId();
  const { data: application, isLoading, error } = useSpace(spaceId ?? "");

  if (!spaceId) return <EmptyState message={t("applications.noAppSelected")} icon={AppWindow} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
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
    /** A member's own space: always private, no members but its owner (§3.6). */
    personal: boolean;
  };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const updateMutation = useUpdateSpace();
  const deleteMutation = useDeleteSpace();

  const domains = application.settings?.allowedRedirectDomains ?? [];
  const [editedDomains, setEditedDomains] = useState<string[] | null>(null);
  const [editedVisibility, setEditedVisibility] = useState<SpaceVisibility | null>(null);
  const [editedDefaultRole, setEditedDefaultRole] = useState<SpaceRolePreset | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A visibility leaving `open`, held until its consequence is confirmed.
  const [pendingClose, setPendingClose] = useState<SpaceVisibility | null>(null);
  // The last write and how it went: each row reports its own field only.
  const [write, setWrite] = useState<{
    field: SpaceSettingChange["field"];
    state: "pending" | "success" | "error";
  } | null>(null);
  const feedback = (field: SpaceSettingChange["field"]) => (
    <SaveFeedback
      pending={write?.field === field && write.state === "pending"}
      success={write?.field === field && write.state === "success"}
      error={write?.field === field && write.state === "error"}
    />
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

  // Each control commits on its own — "the control IS the setting". No Save
  // button under this form: in the settings surfaces a change is a change
  // without pressing something else.
  const save = (change: SpaceSettingChange, onSuccess?: () => void) => {
    const { field } = change;
    setWrite({ field, state: "pending" });
    updateMutation.mutate(
      { params: { path: { id: spaceId } }, body: spaceUpdateBody(change) },
      {
        onSuccess: () => {
          setWrite({ field, state: "success" });
          onSuccess?.();
        },
        onError: (error) => {
          setWrite({ field, state: "error" });
          toastError(error);
        },
      },
    );
  };

  const commitVisibility = (next: SpaceVisibility) => {
    setEditedVisibility(next);
    save({ field: "visibility", value: next }, () => setPendingClose(null));
  };

  const chooseVisibility = (next: SpaceVisibility) => {
    if (next === activeVisibility) return;
    if (visibilityChangeNeedsConfirmation(activeVisibility, next)) setPendingClose(next);
    else commitVisibility(next);
  };

  const commitDefaultRole = (next: SpaceRolePreset) => {
    setEditedDefaultRole(next);
    save({ field: "defaultRole", value: next });
  };

  const commitDomains = (next: string[]) => {
    setEditedDomains(next);
    if (domainsChanged(domains, next)) save({ field: "domains", value: next });
  };

  return (
    <>
      <SettingsGroup title={t("applications.settingsTitle")}>
        <SettingRow variant="field" label={t("applications.nameLabel")} status={feedback("name")}>
          <InlineTextSetting
            value={application.name}
            disabled={updateMutation.isPending}
            aria-label={t("applications.nameLabel")}
            placeholder={t("applications.namePlaceholder")}
            onCommit={(name) => save({ field: "name", value: name })}
          />
        </SettingRow>

        {application.personal ? (
          <p className="text-muted-foreground text-sm">{t("spaces.personal.settingsLocked")}</p>
        ) : (
          <>
            <SettingRow
              variant="field"
              label={t("applications.redirectDomains")}
              description={t("applications.redirectDomainsHint")}
              status={feedback("domains")}
            >
              <div className="flex w-full flex-col gap-2">
                {activeDomains.map((domain, index) => (
                  <div key={index} className="flex w-full items-center gap-2">
                    <Input
                      type="text"
                      value={domain}
                      className="min-w-0 flex-1"
                      onChange={(e) =>
                        setEditedDomains((prev) =>
                          (prev ?? domains).map((d, i) => (i === index ? e.target.value : d)),
                        )
                      }
                      // Commits when you leave the field, like every other setting
                      // here; Enter is the same answer for a single-line input. The
                      // row controls stay enabled during a write: disabling them on
                      // the blur would swallow the click that caused it.
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
              status={feedback("visibility")}
            >
              <div className="flex w-full flex-col gap-3">
                <RadioGroup
                  value={activeVisibility}
                  onValueChange={(value) => chooseVisibility(value as SpaceVisibility)}
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
                  <p className="text-muted-foreground text-xs">
                    {t("spaces.visibilityDefaultLocked")}
                  </p>
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
                status={feedback("defaultRole")}
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
                    emptyMessage={
                      presetOptions.length === 0 ? t("spaces.noAssignablePresets") : null
                    }
                  />
                  <p className="text-muted-foreground text-xs">{t("spaces.defaultRoleImpact")}</p>
                </div>
              </SettingRow>
            )}
          </>
        )}
      </SettingsGroup>

      {/* The danger zone is a settings group like any other. Its exception is
          the CONTROL — a button that opens a confirm — which is what the row
          pattern says a destructive setting looks like, rather than a red-bordered
          card that reads as a different kind of screen. */}
      {!application.isDefault && !application.personal && can("spaces:delete") && (
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
        open={pendingClose !== null}
        onClose={() => setPendingClose(null)}
        title={t("spaces.closeConfirmTitle")}
        confirmLabel={t("spaces.closeConfirm")}
        description={t("spaces.closeUnsharesConnections")}
        isPending={updateMutation.isPending}
        onConfirm={() => pendingClose && commitVisibility(pendingClose)}
      />

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("applications.deleteDialogTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
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
              // A space that homes packages refuses (409 `space_homes_packages`,
              // RBAC spec §6.9) and the detail names them — but not how to act
              // on it, which is one move per package from its own page.
              onError: (error) =>
                toastError(error, {
                  description:
                    error instanceof ApiError && error.code === "space_homes_packages"
                      ? t("spaces.deleteHomesPackagesHint")
                      : undefined,
                }),
            },
          );
        }}
      />
    </>
  );
}
