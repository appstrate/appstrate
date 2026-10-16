// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus, X } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { ConfirmModal } from "../../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { useSpace, useUpdateSpace, useDeleteSpace } from "../../hooks/use-spaces";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { ErrorState, EmptyState } from "../../components/page-states";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { ManualSave } from "../../components/settings/manual-save";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { Label } from "@appstrate/ui/components/label";
import { SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { RoleCatalogState } from "../../components/role-catalog-state";
import { SpaceRoleSelect } from "../../components/space-role-select";
import { useSpaceRoleOptions, type SpaceRolePreset } from "../../hooks/use-roles";
import type { components } from "../../api/client";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { ApiError } from "../../api/errors";
import { toastError } from "../../lib/mutation-error";
import {
  spaceSettingsUpdate,
  visibilityChangeNeedsConfirmation,
} from "../../lib/space-update-body";

type SpaceVisibility = components["schemas"]["SpaceObject"]["visibility"];

export function WorkspaceSettingsGeneralPage() {
  const { t } = useTranslation(["settings", "common"]);
  const spaceId = useCurrentSpaceId();
  const { data: space, isLoading, error } = useSpace(spaceId ?? "");

  if (!spaceId) return <EmptyState message={t("spaces.noSpaceSelected")} icon={AppWindow} />;
  if (isLoading) return <SettingsSkeleton />;
  if (error) return <ErrorState error={error} />;
  if (!space) return <ErrorState />;

  return <GeneralForm key={spaceId} spaceId={spaceId} space={space} />;
}

function GeneralForm({
  spaceId,
  space,
}: {
  spaceId: string;
  space: {
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
  const navigate = useNavigate();
  const updateMutation = useUpdateSpace();
  const deleteMutation = useDeleteSpace();

  const domains = space.settings?.allowedRedirectDomains ?? [];
  const draft = useSettingDraft({
    name: space.name,
    domains,
    visibility: space.visibility,
    defaultRole: space.default_role,
  });
  const {
    domains: activeDomains,
    visibility: activeVisibility,
    defaultRole: activeDefaultRole,
  } = draft.value;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<SpaceVisibility | null>(null);

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

  const commitVisibility = (next: SpaceVisibility) => {
    draft.set((previous) => ({ ...previous, visibility: next }));
    setPendingClose(null);
  };
  const chooseVisibility = (next: SpaceVisibility) => {
    if (next === activeVisibility) return;
    if (visibilityChangeNeedsConfirmation(space.visibility, next)) setPendingClose(next);
    else commitVisibility(next);
  };
  const commitDefaultRole = (next: SpaceRolePreset) =>
    draft.set((previous) => ({ ...previous, defaultRole: next }));
  const commitDomains = (next: string[]) =>
    draft.set((previous) => ({ ...previous, domains: next }));
  const save = async () => {
    const sent = draft.value;
    const body = spaceSettingsUpdate(draft.baseline, sent, space.personal);
    const saved = await updateMutation.mutateAsync({ params: { path: { id: spaceId } }, body });
    draft.accept(sent, {
      name: saved.name,
      domains: saved.settings?.allowedRedirectDomains ?? [],
      visibility: saved.visibility,
      defaultRole: saved.default_role,
    });
  };

  return (
    <>
      <fieldset disabled={updateMutation.isPending}>
        <SettingsGroup title={t("workspaceSettings.sectionGeneral")}>
          <SettingRow variant="field" label={t("spaces.nameLabel")}>
            <Input
              value={draft.value.name}
              disabled={updateMutation.isPending}
              aria-label={t("spaces.nameLabel")}
              placeholder={t("spaces.namePlaceholder")}
              onChange={(event) =>
                draft.set((previous) => ({ ...previous, name: event.target.value }))
              }
            />
          </SettingRow>

          {space.personal ? (
            <p className="text-muted-foreground text-sm">{t("spaces.personal.settingsLocked")}</p>
          ) : (
            <>
              <SettingRow
                variant="field"
                label={t("spaces.redirectDomains")}
                description={t("spaces.redirectDomainsHint")}
              >
                <div className="flex w-full flex-col gap-2">
                  {activeDomains.map((domain, index) => (
                    <div key={index} className="flex w-full items-center gap-2">
                      <Input
                        type="text"
                        value={domain}
                        className="min-w-0 flex-1"
                        onChange={(e) =>
                          commitDomains(
                            activeDomains.map((d, i) => (i === index ? e.target.value : d)),
                          )
                        }
                        placeholder="example.com"
                        aria-label={t("spaces.domainAriaLabel", { index: index + 1 })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("spaces.removeDomain")}
                        onClick={() => commitDomains(activeDomains.filter((_, i) => i !== index))}
                      >
                        <X />
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
                    onClick={() => commitDomains([...activeDomains, ""])}
                  >
                    <Plus className="mr-1.5" />
                    {t("spaces.addDomain")}
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
              >
                <div className="flex w-full flex-col gap-3">
                  <RadioGroup
                    value={activeVisibility}
                    onValueChange={(value) => chooseVisibility(value as SpaceVisibility)}
                    disabled={space.isDefault || updateMutation.isPending}
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
                  {space.isDefault && (
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
                >
                  <div className="flex w-full flex-col gap-2">
                    <SpaceRoleSelect
                      id="space-default-role"
                      className="w-full sm:w-[240px]"
                      value={activeDefaultRole}
                      options={presetOptions}
                      fallbackLabel={t(`roles.preset.${activeDefaultRole}`)}
                      disabled={updateMutation.isPending}
                      loading={rolesLoading || !rolesKnown}
                      onValueChange={(value) => commitDefaultRole(value as SpaceRolePreset)}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t(`roles.presetDesc.${activeDefaultRole}`)}
                    </p>
                    <RoleCatalogState
                      pending={null}
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
      </fieldset>
      <ManualSave
        dirty={draft.dirty}
        pending={updateMutation.isPending}
        onSave={save}
        onDiscard={draft.reset}
      />

      {/* The danger zone is a settings group like any other. Its exception is
          the CONTROL — a button that opens a confirm — which is what the row
          pattern says a destructive setting looks like, rather than a red-bordered
          card that reads as a different kind of screen. */}
      {!space.isDefault && !space.personal && can("spaces:delete") && (
        <SettingsGroup title={t("spaces.dangerZone")}>
          <SettingRow
            variant="action"
            label={t("spaces.deleteTitle")}
            description={t("spaces.deleteDesc")}
          >
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {deleteMutation.isPending ? t("spaces.deleting") : t("btn.delete")}
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
        title={t("spaces.deleteDialogTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={t("spaces.deleteConfirm", { name: space.name })}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(
            { params: { path: { id: spaceId } } },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                navigate("/org-settings/spaces");
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
